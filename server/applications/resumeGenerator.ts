import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";

/**
 * No real document-generation pipeline exists yet (no pdfkit or
 * equivalent is installed, no LLM template/prompt system exists) — these
 * are honest placeholder version tags, not a real template or model,
 * satisfying PRD §16.3's "record ... template version, model/prompt
 * version" requirement without pretending a generation step happened
 * that didn't. facts are echoed verbatim from confirmed data, never
 * paraphrased or embellished, so "never add unsupported skills,
 * employers, dates or metrics" holds trivially at this stage.
 */
/**
 * Exported at Task H3 so resumeForSubmission can record it: PRD §16.3 requires the
 * template version on the generated document, and the module that renders from
 * the template is the only place that legitimately knows it.
 */
export const TEMPLATE_VERSION = "plain-json-v0";
const MODEL_VERSION = "verbatim-confirmed-facts-v0";

export class NoConfirmedFactsError extends Error {
  constructor(candidateId: string) {
    super(`No confirmed facts exist for candidate ${candidateId} — cannot generate a resume payload`);
    this.name = "NoConfirmedFactsError";
  }
}

/**
 * R7-M12: thrown by verifyFactuality when a fact in a payload doesn't trace
 * back to a confirmed extracted_facts row — formalizes an invariant
 * generateResumePayload's own query logic already guarantees on its normal
 * path, as an explicit, independently testable check rather than leaving it
 * implicit, so a future change to that logic can't silently violate PRD
 * §16.3's "never add unsupported ... data" requirement without a test
 * catching it.
 */
export class FactualityViolationError extends Error {
  constructor(public readonly extractedFactId: string) {
    super(
      `Fact ${extractedFactId} is not present in the candidate's confirmed facts — factuality check failed.`,
    );
    this.name = "FactualityViolationError";
  }
}

export interface ResumeFactEntry {
  extractedFactId: string;
  factType: string;
  factValue: string;
  /**
   * R7-M12 (PRD §16.3 "select evidence relevant to the vacancy"):
   * annotate-not-filter, per the locked design decision — every confirmed
   * fact always stays in the payload; this only marks whether it matched.
   * See isRelevantToVacancy's own doc comment for the matching semantics.
   */
  relevant: boolean;
}

export interface ResumePayload {
  candidateId: string;
  facts: ResumeFactEntry[];
  templateVersion: string;
  modelVersion: string;
  outputHash: string;
  generatedAt: string;
}

/**
 * PRD §16.3 ATS resume generation, minimal foundation: structures the
 * candidate's confirmed facts into a flat JSON payload — a proxy for a
 * generated document, since no real generation pipeline exists yet
 * (PRD §16.2's channel adapters are the same class of not-yet-built
 * dependency). Two-step query (facts, then confirmations for those fact
 * ids) mirrors evaluateVerifiedFacts's own shape.
 *
 * Throws NoConfirmedFactsError — not a generic Error — when the
 * candidate has zero confirmed facts, so a caller can distinguish "ask
 * the candidate to confirm facts first" from an actual database failure.
 *
 * R7-M12: vacancyTitle is an optional third parameter, not a query this
 * function makes itself — same "caller already fetched the row, pass the
 * field down" convention as eligibilityGate.ts's evaluateRoleMatch, so this
 * doesn't add a second vacancies query for data a caller already has.
 * Omitting it (or passing an empty/whitespace-only string) is a legitimate
 * call shape, not an error — every fact is simply annotated not-relevant,
 * since there is nothing to match against.
 */
export async function generateResumePayload(
  client: SupabaseClient,
  candidateId: string,
  vacancyTitle?: string,
): Promise<ResumePayload> {
  const { data: factRows, error: factError } = await client
    .from("extracted_facts")
    .select("id, fact_type, fact_value")
    .eq("candidate_id", candidateId);

  if (factError) {
    throw factError;
  }

  const facts = (factRows ?? []) as Array<{ id: string; fact_type: string; fact_value: string }>;

  if (facts.length === 0) {
    throw new NoConfirmedFactsError(candidateId);
  }

  const factIds = facts.map((fact) => fact.id);

  const { data: confirmationRows, error: confirmationError } = await client
    .from("fact_confirmations")
    .select("extracted_fact_id, corrected_value")
    .in("extracted_fact_id", factIds)
    .eq("status", "confirmed");

  if (confirmationError) {
    throw confirmationError;
  }

  // MP-F2: corrected_value is null when the candidate confirmed the
  // extracted value as-is, non-null when they edited it — a resume must
  // reflect what the candidate actually confirmed, not the raw extraction,
  // so corrected_value (when present) wins over extracted_facts.fact_value.
  const correctedValueByFactId = new Map(
    ((confirmationRows ?? []) as Array<{ extracted_fact_id: string; corrected_value: string | null }>).map((row) => [
      row.extracted_fact_id,
      row.corrected_value,
    ]),
  );
  const confirmedFactIds = new Set(correctedValueByFactId.keys());

  const confirmedFacts: ResumeFactEntry[] = facts
    .filter((fact) => confirmedFactIds.has(fact.id))
    .map((fact) => {
      const effectiveValue = correctedValueByFactId.get(fact.id) ?? fact.fact_value;
      return {
        extractedFactId: fact.id,
        factType: fact.fact_type,
        factValue: effectiveValue,
        relevant: isRelevantToVacancy(effectiveValue, vacancyTitle),
      };
    });

  if (confirmedFacts.length === 0) {
    throw new NoConfirmedFactsError(candidateId);
  }

  verifyFactuality(confirmedFacts, confirmedFactIds);

  const outputHash = createHash("sha256").update(JSON.stringify(confirmedFacts)).digest("hex");

  return {
    candidateId,
    facts: confirmedFacts,
    templateVersion: TEMPLATE_VERSION,
    modelVersion: MODEL_VERSION,
    outputHash,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * R7-M12 (PRD §16.3 "select evidence relevant to the vacancy"): deliberately
 * the same case-insensitive substring technique as eligibilityGate.ts's
 * evaluateRoleMatch — normalizedTitle.includes(normalizedValue) — reused
 * rather than a second matching convention invented for this file. Matches
 * against factValue only (the fact's actual content), not factType (a
 * category label like "years_of_experience"), since fact_type has no fixed,
 * PRD-defined taxonomy in this repository (same reasoning
 * extracted_facts.sql documents for not CHECK-constraining it) and matching
 * against an arbitrary label would be guessing, not an honest textual
 * signal. Both sides empty/blank return false — same "a blank value
 * matching every title" guard evaluateRoleMatch already documents — so a
 * missing vacancyTitle (or a fact with blank factValue) is reported as
 * not relevant, never as a false match.
 */
function isRelevantToVacancy(factValue: string, vacancyTitle: string | undefined): boolean {
  const normalizedTitle = (vacancyTitle ?? "").trim().toLowerCase();
  const normalizedValue = factValue.trim().toLowerCase();

  return normalizedTitle.length > 0 && normalizedValue.length > 0 && normalizedTitle.includes(normalizedValue);
}

/**
 * R7-M12 (PRD §16.3 "never add unsupported ... data"): an explicit,
 * independently unit-testable assertion of the invariant
 * generateResumePayload's own confirmedFactIds filter already guarantees on
 * its normal path — every fact in `facts` must trace back to a confirmed
 * extracted_facts row. Exported so a test can construct a payload that
 * deliberately violates the invariant directly, without needing to break
 * generateResumePayload's actual query logic to exercise the failure path.
 * Throws on the first violation found rather than collecting all of them:
 * one violation is already a factuality failure severe enough to reject the
 * whole payload, so there is no case where a caller needs the full list.
 */
export function verifyFactuality(facts: ResumeFactEntry[], confirmedFactIds: Set<string>): void {
  for (const fact of facts) {
    if (!confirmedFactIds.has(fact.extractedFactId)) {
      throw new FactualityViolationError(fact.extractedFactId);
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Mini-Phase 11 — AI resume tailoring.
 *
 * WHAT THIS IS. The candidate's Profile preference
 * (candidate_profiles.resume_optimization_level) decides whether an
 * application's resume is submitted verbatim or rewritten first:
 *
 *   off         the stored base resume is used as-is; the model is NEVER called
 *   honest      wording and ordering are tailored, facts are untouched
 *   aggressive  rewording is pushed harder for ATS keyword match, still on the
 *               same facts
 *
 * THE ANTI-FABRICATION MECHANISM IS STRUCTURAL, NOT A PROMPT HOPE. The model
 * must return, for every bullet, the extractedFactIds it was built from, and
 * every cited id is checked against the candidate's CONFIRMED facts before the
 * result is accepted. A bullet that cites nothing real is rejected outright, so
 * "the model agreed not to invent things" is not what keeps this honest — a
 * citation check is. This is the same verifyFactuality discipline the JSON
 * payload generator already applies, extended to generated prose.
 *
 * SCOPE. This module produces the tailored CONTENT. Turning that content into a
 * stored file, attaching it to an application_attempts row, and having the
 * submission adapter pick it up are deliberately NOT done here — see the
 * summary for the schema decisions those need.
 * ------------------------------------------------------------------------- */

export const RESUME_OPTIMIZATION_LEVELS = ["off", "honest", "aggressive"] as const;

export type ResumeOptimizationLevel = (typeof RESUME_OPTIMIZATION_LEVELS)[number];

/** Denormalized from the column's own default in 20260917140000. */
export const DEFAULT_RESUME_OPTIMIZATION_LEVEL: ResumeOptimizationLevel = "honest";

/** Exported so the storage layer can validate a level read back from a row without a second copy of the allowed set. */
export function isResumeOptimizationLevel(value: unknown): value is ResumeOptimizationLevel {
  return typeof value === "string" && (RESUME_OPTIMIZATION_LEVELS as readonly string[]).includes(value);
}

/**
 * Reads the candidate's preference. An unrecognised or missing value falls back
 * to the column default rather than throwing: a preference read is not a place
 * to fail an application, and "honest" is the column's own default anyway.
 */
export async function readResumeOptimizationLevel(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
): Promise<ResumeOptimizationLevel> {
  const { data, error } = await client
    .from("candidate_profiles")
    .select("resume_optimization_level")
    .eq("id", candidateId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const stored = (data as { resume_optimization_level?: unknown } | null)?.resume_optimization_level;

  return isResumeOptimizationLevel(stored) ? stored : DEFAULT_RESUME_OPTIMIZATION_LEVEL;
}

/** Bumped whenever either prompt below changes, so a stored artifact says which wording produced it. */
export const RESUME_TAILORING_PROMPT_VERSION = "resume-tailoring-v2";

export const DEFAULT_TAILORING_MODEL = "openai/gpt-4o-mini";

/**
 * The output ceiling for BOTH OpenAI calls this pipeline makes: the tailored resume and the
 * cover letter.
 *
 * WHY AN EXPLICIT CEILING AT ALL. Without one the SDK asks the provider for the model's maximum -
 * 16,384 tokens for gpt-4o-mini - on every single request, whatever the response actually needs.
 * That is two problems rather than one:
 *
 *   1. A RUNAWAY GENERATION IS UNBOUNDED. Nothing here truncates a response that decides to keep
 *      writing, so the cost and the latency of one bad sample are whatever the model feels like.
 *
 *   2. THE PROVIDER RESERVES AGAINST THE REQUEST, NOT THE RESULT. OpenRouter refuses a request
 *      whose max_tokens exceeds the account's remaining credit - "402 ... You requested up to
 *      16384 tokens, but can only afford 15703" - even though the real response is about 1,500
 *      tokens. A ceiling that is generous relative to the payload therefore buys availability,
 *      not just tidiness. That is how this was found: an entire reliability run was blocked by a
 *      reservation for ten times the output it ever produced.
 *
 * WHY 4096. The largest tailored response observed end to end is roughly 1,500 tokens, so this is
 * over double the headroom needed and a quarter of the default. It is a CEILING and not a target:
 * raising it costs nothing until a response needs the tokens, and dropping it below the real
 * payload would truncate JSON and turn a good response into a MalformedTailoredResumeError.
 *
 * SHARED BY BOTH GENERATORS ON PURPOSE. Two separate ceilings holding the same number drift the
 * moment somebody tunes one, and the failure would be silent - the resume capped while the cover
 * letter quietly kept reserving 16k.
 */
export const MODEL_MAX_OUTPUT_TOKENS = 4096;

/**
 * HONEST: reorder and reword, never restate a fact as something it is not.
 * The prohibition list is explicit and specific because "don't lie" is not an
 * instruction a model can act on; "do not add a technology the facts do not
 * name" is.
 */
export const HONEST_SYSTEM_PROMPT = [
  "You tailor an existing resume to a specific job posting.",
  "",
  "You are given the candidate's CONFIRMED facts. They are the only source of truth.",
  "",
  "HONEST mode — what you MAY do:",
  "- Reorder facts so the most relevant appear first.",
  "- Reword descriptions for clarity and to mirror the posting's vocabulary where the",
  "  underlying fact already supports it.",
  "- Shorten or omit facts that are irrelevant to this posting.",
  "",
  "HONEST mode — what you MUST NOT do:",
  "- Do not add any employer, job title, date, qualification, metric, or technology",
  "  that is not named in the confirmed facts.",
  "- Do not upgrade a claim. 'Familiar with' must not become 'expert in'; 'contributed",
  "  to' must not become 'led'.",
  "- Do not infer a skill from a job title or an employer name.",
  "",
  "Every bullet must cite the extractedFactIds it was written from. A bullet you",
  "cannot cite must not be written.",
  "",
  "Every field you return is a claim, so every field carries its own citations. The",
  "shape is:",
  '  {"headline": {"text": string, "factRefs": string[]},',
  '   "summary":  {"text": string, "factRefs": string[]},',
  '   "bullets":  [{"text": string, "factRefs": string[]}],',
  '   "skills":   [{"text": string, "factRefs": string[]}]}',
  "",
  "THE SUMMARY IS A CLAIM LIKE ANY OTHER, AND IT IS THE ONE MOST OFTEN LEFT UNCITED.",
  "A summary reads like an overview, so it is tempting to write a strong one and cite",
  "nothing. Do not. A summary that synthesises several facts must name ALL of them in",
  "its factRefs. An uncited summary is not a partial success: the ENTIRE response is",
  "rejected and thrown away, including the bullets and skills that were cited correctly.",
  "",
  "WORKED EXAMPLE. Given these three confirmed facts:",
  "  [f-001] (experience) Rebuilt the nightly ingestion platform, cutting it from nine hours to seventy minutes",
  "  [f-002] (skill) Apache Spark",
  "  [f-003] (skill) Kafka",
  "this summary is REJECTED, because its factRefs is empty:",
  '  {"text": "Data engineer building high-throughput pipelines in Spark and Kafka.", "factRefs": []}',
  "and this summary is ACCEPTED, with exactly the same words, because every part of it",
  "traces to a named fact:",
  '  {"text": "Data engineer building high-throughput pipelines in Spark and Kafka.", "factRefs": ["f-001", "f-002", "f-003"]}',
  "The wording is not what makes the difference. The citations are.",
  "",
  "Each factRefs array names the extractedFactIds that text was written from. Text",
  "you cannot cite must not be written: if you have nothing grounded to put in a",
  'section, return it as {"text": "", "factRefs": []} and it will be left out.',
  "Skills may only be restated from the facts, never added to them.",
  "Reply with JSON only.",
].join("\n");

/**
 * AGGRESSIVE: maximise keyword overlap with the posting, still without
 * inventing. The difference from HONEST is how far a fact may be reworded and
 * how eagerly adjacent evidence may be surfaced — NOT whether facts may be
 * created. That boundary is stated here so the prompt cannot be read as a
 * licence to fabricate.
 */
export const AGGRESSIVE_SYSTEM_PROMPT = [
  "You tailor an existing resume to a specific job posting for maximum ATS match.",
  "",
  "You are given the candidate's CONFIRMED facts. They are the only source of truth.",
  "",
  "AGGRESSIVE mode — what you MAY do:",
  "- Reword facts forcefully, using the posting's own terminology wherever the fact",
  "  genuinely supports it, so keyword matching scores as high as possible.",
  "- Promote tangential or adjacent evidence the facts already contain: surface a",
  "  technology used once, or a responsibility mentioned in passing, and give it",
  "  prominence when it matches the posting.",
  "- Reorder freely, lead with the strongest match, and compress everything else.",
  "",
  "AGGRESSIVE mode — what you MUST NOT do:",
  "- Do not add any employer, job title, date, qualification, metric, or technology",
  "  that is not named in the confirmed facts. Aggressive is a matter of framing,",
  "  never of invention.",
  "- Do not claim proficiency the facts do not show.",
  "- Do not infer a skill from a job title or an employer name.",
  "",
  "Every bullet must cite the extractedFactIds it was written from. A bullet you",
  "cannot cite must not be written.",
  "",
  "Every field you return is a claim, so every field carries its own citations. The",
  "shape is:",
  '  {"headline": {"text": string, "factRefs": string[]},',
  '   "summary":  {"text": string, "factRefs": string[]},',
  '   "bullets":  [{"text": string, "factRefs": string[]}],',
  '   "skills":   [{"text": string, "factRefs": string[]}]}',
  "Each factRefs array names the extractedFactIds that text was written from. Text",
  "you cannot cite must not be written: if you have nothing grounded to put in a",
  'section, return it as {"text": "", "factRefs": []} and it will be left out.',
  "Skills may only be restated from the facts, never added to them.",
  "Reply with JSON only.",
].join("\n");

/**
 * The prompt for a level, or null for "off".
 *
 * Returning null rather than an empty-string prompt is what makes the bypass
 * testable: the caller checks for null and skips the model call entirely, so
 * there is no code path where "off" reaches the API with a degenerate prompt.
 */
export function systemPromptFor(level: ResumeOptimizationLevel): string | null {
  if (level === "off") return null;
  return level === "honest" ? HONEST_SYSTEM_PROMPT : AGGRESSIVE_SYSTEM_PROMPT;
}

/**
 * One claim in the tailored resume, with the confirmed facts it was written
 * from.
 *
 * EVERY piece of text the model produces uses this shape — headline, summary,
 * bullets and skills alike. An earlier version of this used a bare string for
 * headline/summary/skills and only bullets carried citations, which left three
 * unguarded places to put a fabricated claim: a summary sentence needs no
 * factRef, and a "skills" list is exactly where an invented technology would do
 * the most damage to an ATS score. One shape everywhere means one check
 * everywhere.
 */
export interface GroundedText {
  text: string;
  factRefs: string[];
}

export interface TailoredResumeContent {
  headline: GroundedText;
  summary: GroundedText;
  bullets: GroundedText[];
  skills: GroundedText[];
}

/** Every claim in a result, flattened, so validation has one list to walk. */
export function allClaims(content: TailoredResumeContent): GroundedText[] {
  return [content.headline, content.summary, ...content.bullets, ...content.skills];
}

export class MalformedTailoredResumeError extends Error {
  constructor(detail: string) {
    super(`Tailored resume response was not usable: ${detail}`);
    this.name = "MalformedTailoredResumeError";
  }
}

/**
 * The model cited something that is not a confirmed fact. This is the
 * fabrication case: it means content was produced from a source that does not
 * exist, so nothing in the result can be trusted to be partial — the whole
 * result is refused rather than the offending claim being dropped.
 */
export class FabricatedContentError extends Error {
  constructor(public readonly unknownFactRefs: string[]) {
    // Deliberately does NOT name the artifact. This class is raised by the
    // shared gate for resumes and cover letters alike, and an earlier wording
    // said "Tailored resume" — which meant a refused cover letter reported
    // itself as a resume, sending anyone reading the error to the wrong file.
    // The caller knows which artifact it asked for; this does not.
    super(
      `Generated content cited fact ids that are not among the candidate's confirmed facts: ${unknownFactRefs.join(", ")}. Refusing content built on facts the candidate never confirmed.`,
    );
    this.name = "FabricatedContentError";
  }
}

/**
 * The model wrote a claim and cited nothing for it. Distinct from fabrication
 * and distinct from a schema error: the text may well be true, but this code
 * has no way to tell, and "probably true" is not the standard a resume the
 * candidate never read has to meet.
 */
export class UncitedClaimError extends Error {
  constructor(public readonly uncitedTexts: string[]) {
    // Artifact-neutral for the same reason as FabricatedContentError above.
    super(
      `Generated content contains ${uncitedTexts.length} claim(s) with no cited confirmed fact: ${uncitedTexts
        .map((text) => JSON.stringify(text))
        .join(", ")}. Every claim must trace to a fact the candidate confirmed.`,
    );
    this.name = "UncitedClaimError";
  }
}

export function isGroundedText(value: unknown): value is GroundedText {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<GroundedText>;
  return (
    typeof entry.text === "string" && Array.isArray(entry.factRefs) && entry.factRefs.every((ref) => typeof ref === "string")
  );
}

export interface VerifiedClaims {
  /** How many distinct confirmed facts the result actually drew on. */
  citedFactCount: number;
}

/**
 * THE HONESTY GATE, as one function.
 *
 * Extracted from tailorResumeForVacancy so cover letters run the identical
 * check rather than a re-typed version of it. Two callers paraphrasing "every
 * claim must cite a confirmed fact" is exactly how one of them quietly stops
 * enforcing it, and the anti-fabrication guarantee is the whole point of both
 * generators.
 *
 * Two checks, in this order:
 *
 *   1. A non-empty claim with no citation is refused. The prompts ask for
 *      citations, but a prompt is a request, not an enforcement mechanism.
 *   2. Every cited id must be among the candidate's confirmed facts. A citation
 *      to a fact that does not exist is fabrication wearing the costume of
 *      evidence, and it poisons the whole result — the citation check is the
 *      only reason any of this can be trusted, so a single bad ref means the
 *      result cannot be partially trusted and is refused outright rather than
 *      having the offending claim dropped.
 *
 * Empty claims are permitted and are the caller's problem to render or skip:
 * an empty paragraph is a section the model declined to write, not a claim.
 */
export function verifyGroundedClaims(
  claims: readonly GroundedText[],
  confirmedFactIds: ReadonlySet<string>,
): VerifiedClaims {
  const uncited = claims
    .filter((claim) => claim.text.trim().length > 0 && claim.factRefs.length === 0)
    .map((claim) => claim.text);

  if (uncited.length > 0) {
    throw new UncitedClaimError(uncited);
  }

  const cited = new Set(claims.flatMap((claim) => claim.factRefs));
  const unknownRefs = [...cited].filter((ref) => !confirmedFactIds.has(ref));

  if (unknownRefs.length > 0) {
    throw new FabricatedContentError(unknownRefs);
  }

  return { citedFactCount: cited.size };
}

function isValidTailoredContent(value: unknown): value is TailoredResumeContent {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<TailoredResumeContent>;

  return (
    isGroundedText(candidate.headline) &&
    isGroundedText(candidate.summary) &&
    Array.isArray(candidate.bullets) &&
    candidate.bullets.every(isGroundedText) &&
    Array.isArray(candidate.skills) &&
    candidate.skills.every(isGroundedText)
  );
}

/**
 * Thrown when the candidate has never uploaded a resume. "off" has nothing to
 * fall back to in that case, and saying so plainly beats submitting an
 * application with no attachment.
 */
export class MissingBaseResumeError extends Error {
  constructor(candidateId: string) {
    super(`Candidate ${candidateId} has no resume_documents row, so there is no base resume to submit.`);
    this.name = "MissingBaseResumeError";
  }
}

export interface BaseResumeDocument {
  documentId: string;
  storagePath: string;
  originalFilename: string;
  mimeType: string;
  /**
   * The level that produced this document; null for a file the candidate
   * uploaded, which no level produced. Read from the row rather than from the
   * current preference, so a document prepared under one setting and submitted
   * after the candidate changed it still reports what it actually is.
   */
  optimizationLevel: ResumeOptimizationLevel | null;
}

/**
 * The resume the candidate uploaded themselves — what "off" submits unchanged
 * and what the rewriting levels are derived from.
 *
 * SAME QUERY AS greenhouse.ts's defaultDownloadResume, deliberately: "the
 * candidate's most recent resume_documents row" is already an established
 * convention in this repo, and inventing a second definition here would let the
 * two drift.
 *
 * CAVEAT THAT MUST BE RESOLVED BEFORE TAILORED RESUMES ARE EVER STORED. This
 * query currently cannot tell an uploaded resume from a generated one, so the
 * moment a tailored resume is written into resume_documents it would become
 * "the latest" and "off" would start submitting a rewritten resume — the exact
 * failure the setting exists to prevent. Closing that requires a kind/role
 * marker on resume_documents (see the summary's decision D3); until then no
 * tailored row is written and this query is unambiguous.
 */
export async function loadBaseResumeDocument(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
): Promise<BaseResumeDocument> {
  const { data, error } = await client
    .from("resume_documents")
    .select("id, storage_path, original_filename, mime_type, optimization_level")
    .eq("candidate_id", candidateId)
    // Only a file the candidate themselves provided may serve as the base
    // resume. Without this, a tailored resume generated for an earlier vacancy
    // — being newer — would be picked up as "the base", and the 'off' setting
    // would submit a rewritten resume while claiming to have left it alone.
    .eq("kind", "uploaded")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    throw new MissingBaseResumeError(candidateId);
  }

  const row = data as {
    id: string;
    storage_path: string;
    original_filename: string;
    mime_type: string;
    optimization_level: ResumeOptimizationLevel | null;
  };

  return {
    documentId: row.id,
    storagePath: row.storage_path,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    optimizationLevel: isResumeOptimizationLevel(row.optimization_level) ? row.optimization_level : null,
  };
}

/**
 * Loads one stored document by id — the read half of the reuse path, used when
 * an attempt already names the document it is going to submit.
 *
 * Returns null rather than throwing when the row is gone. That is a real case,
 * not a defensive one: application_attempts.resume_document_id is
 * ON DELETE SET NULL, so a candidate deleting a tailored resume clears the
 * link, and this function would simply never be asked about it. Returning null
 * lets the caller fall back to preparing a fresh document.
 */
export async function loadResumeDocumentById(
  client: Pick<SupabaseClient, "from">,
  documentId: string,
): Promise<BaseResumeDocument | null> {
  const { data, error } = await client
    .from("resume_documents")
    .select("id, storage_path, original_filename, mime_type, optimization_level")
    .eq("id", documentId)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    return null;
  }

  const row = data as {
    id: string;
    storage_path: string;
    original_filename: string;
    mime_type: string;
    optimization_level: ResumeOptimizationLevel | null;
  };

  return {
    documentId: row.id,
    storagePath: row.storage_path,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    optimizationLevel: isResumeOptimizationLevel(row.optimization_level) ? row.optimization_level : null,
  };
}

export type TailorResumeResult =
  | { kind: "bypassed"; level: "off"; reason: string; baseResume: BaseResumeDocument }
  | {
      kind: "generated";
      level: Exclude<ResumeOptimizationLevel, "off">;
      content: TailoredResumeContent;
      modelVersion: string;
      promptVersion: string;
      /** How many of the candidate's confirmed facts the model actually drew on. */
      citedFactCount: number;
    };

export interface TailorResumeDeps {
  openai: Pick<OpenAI, "chat">;
}

export interface TailorResumeInput {
  candidateId: string;
  vacancyId: string;
  /** Injectable for deterministic tests; defaults to the env-configured model. */
  model?: string;
  /**
   * A preference already read by the caller. Omitted, it is read from
   * candidate_profiles. Callers that must act on the same value twice pass it,
   * so a setting changed mid-flight cannot make one submission obey two
   * different preferences.
   */
  level?: ResumeOptimizationLevel;
}

/**
 * The job description the tailoring is aimed at. A snapshot is preferred; when
 * none exists the posting title alone is used and jdTextAvailable is false, so
 * the prompt says honestly how much it had to work with rather than implying a
 * full description was supplied.
 */
export async function loadJobDescription(
  client: Pick<SupabaseClient, "from">,
  vacancyId: string,
): Promise<{ title: string; jdText: string | null }> {
  const { data: vacancy, error: vacancyError } = await client
    .from("vacancies")
    .select("raw_title")
    .eq("id", vacancyId)
    .maybeSingle();

  if (vacancyError) {
    throw vacancyError;
  }

  const { data: snapshot, error: snapshotError } = await client
    .from("vacancy_jd_snapshots")
    .select("clean_text")
    .eq("vacancy_id", vacancyId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (snapshotError) {
    throw snapshotError;
  }

  return {
    title: (vacancy as { raw_title: string } | null)?.raw_title ?? "",
    jdText: (snapshot as { clean_text: string } | null)?.clean_text ?? null,
  };
}

function renderTailoringInput(
  facts: ResumeFactEntry[],
  job: { title: string; jdText: string | null },
): string {
  const factLines = facts.map(
    (fact) => `- [${fact.extractedFactId}] (${fact.factType}) ${fact.factValue}`,
  );

  return [
    "CONFIRMED FACTS (the only permitted source):",
    ...factLines,
    "",
    "TARGET POSTING",
    `Title: ${job.title || "(untitled)"}`,
    job.jdText
      ? `Description:\n${job.jdText}`
      : "Description: none available — tailor against the title only, and change as little as possible.",
  ].join("\n");
}

/**
 * How many times a tailoring response is generated before an uncited claim is fatal.
 *
 * TWO, NOT MORE. The failure being retried is a FORMATTING OMISSION rather than a wrong answer:
 * the model had the right confirmed facts in front of it and left factRefs empty, so a second
 * sample is genuinely likely to differ. Re-asking after a second failure would be paying twice
 * for the same instruction-following problem, and the honest outcome then is to report it.
 */
export const TAILORING_MAX_ATTEMPTS = 2;

export interface GeneratedTailoring {
  content: TailoredResumeContent;
  citedFactCount: number;
}

/**
 * Generate one tailoring response and put it through the honesty gate, retrying ONCE when the
 * only objection is an uncited claim.
 *
 * WHY ONLY THAT FAILURE IS RETRIED. An uncited claim is a prompt-adherence slip. The others are
 * not:
 *
 *   * FabricatedContentError cites a fact that does not exist, which is precisely what the gate
 *     exists to catch. Retrying it is hoping a wrong answer becomes right, and eventually it
 *     would succeed at turning a caught fabrication into a submitted one.
 *   * A malformed response is not JSON and will not become JSON on the second ask.
 *
 * THE RETRY COSTS NOTHING. The caller reserves one AI credit per APPLICATION ATTEMPT rather than
 * per model call (see the generate-preview route's reservationKey), so a second sample spends no
 * additional credit.
 *
 * WHY THE TELEMETRY LIVES HERE. This failure is invisible from outside: the route answers with a
 * generic 500, the credit is refunded, and the candidate is told nothing. Without the model's
 * actual text there is no way to tell a model that ignored the citation instruction from one
 * that wrote something the prompt never asked it to cite - which is the difference between a
 * prompt bug and a gate bug, and it is exactly the ambiguity an end-to-end run was needed to
 * surface.
 *
 * THE LOGGED TEXT IS CANDIDATE-DERIVED: the model paraphrases the candidate's confirmed facts,
 * so it is personal data. It belongs in access-controlled logs and must not be shipped to a
 * third-party aggregator that is not already trusted with the candidate's resume.
 */
async function generateVerifiedTailoring(
  callModel: () => Promise<{ choices: Array<{ message?: { content?: string | null } | null }> }>,
  confirmedIds: ReadonlySet<string>,
  context: { candidateId: string; vacancyId: string; level: string; model: string },
): Promise<GeneratedTailoring> {
  let lastRawResponse = "";

  for (let attempt = 1; attempt <= TAILORING_MAX_ATTEMPTS; attempt += 1) {
    try {
      const completion = await callModel();
      // Captured BEFORE anything can reject it, so the catch below always logs the exact text
      // that failed rather than a reconstruction of it.
      const raw = completion.choices[0]?.message?.content ?? "";
      lastRawResponse = raw;

      if (raw.length === 0) {
        throw new MalformedTailoredResumeError("empty response content");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new MalformedTailoredResumeError("response content was not valid JSON");
      }

      if (!isValidTailoredContent(parsed)) {
        throw new MalformedTailoredResumeError("response did not match the expected tailoring schema");
      }

      // THE HONESTY GATE. Two checks, in this order, over every claim in the result —
      // headline, summary, bullets and skills alike. Shared verbatim with the cover letter
      // generator; see verifyGroundedClaims.
      const { citedFactCount } = verifyGroundedClaims(allClaims(parsed), confirmedIds);

      return { content: parsed, citedFactCount };
    } catch (error) {
      if (!(error instanceof UncitedClaimError)) {
        throw error;
      }

      const willRetry = attempt < TAILORING_MAX_ATTEMPTS;

      console.error(
        willRetry
          ? "[resume] tailoring produced an uncited claim; retrying once"
          : "[resume] tailoring produced an uncited claim on the retry too; giving up",
        {
          ...context,
          attempt,
          uncitedTexts: error.uncitedTexts,
          rawResponse: lastRawResponse,
        },
      );

      if (!willRetry) {
        throw error;
      }
    }
  }

  // Unreachable in practice: the loop returns on success and throws on its final failure.
  // Present so the compiler can see that this function always produces a value.
  throw new MalformedTailoredResumeError("tailoring produced no verified content");
}

/**
 * Reads the confirmed facts, loads the posting, and — unless the preference is
 * "off" — asks the model for tailored content and validates it against the
 * candidate's confirmed fact ids.
 */
export async function tailorResumeForVacancy(
  client: SupabaseClient,
  deps: TailorResumeDeps,
  input: TailorResumeInput,
): Promise<TailorResumeResult> {
  const level = input.level ?? (await readResumeOptimizationLevel(client, input.candidateId));

  // "off" returns before the fact query, before the posting query, and before
  // any model client method is touched. That ordering is the bypass: there is no
  // reachable path from here to a chat completion, so "off" cannot rewrite a
  // resume even if the model would have produced something good.
  if (level === "off") {
    return {
      kind: "bypassed",
      level: "off",
      reason:
        'resume_optimization_level is "off": the stored base resume is submitted unmodified and no model call is made.',
      baseResume: await loadBaseResumeDocument(client, input.candidateId),
    };
  }

  // Narrowed to the two rewriting levels by the branch above. A level that has
  // no prompt throws rather than quietly falling back to the honest prompt, so
  // adding a level without writing its prompt fails loudly.
  const systemPrompt = systemPromptFor(level);
  if (systemPrompt === null) {
    throw new MalformedTailoredResumeError(`no system prompt is defined for level "${level}"`);
  }

  const payload = await generateResumePayload(client, input.candidateId);
  const confirmedIds = new Set(payload.facts.map((fact) => fact.extractedFactId));

  const job = await loadJobDescription(client, input.vacancyId);

  const model =
    input.model ??
    process.env.RESUME_TAILORING_MODEL ??
    process.env.OPENAI_MODEL ??
    process.env.OPENROUTER_MODEL ??
    DEFAULT_TAILORING_MODEL;

  // Rendered once and reused across attempts: a retry re-asks the SAME question rather than
  // rebuilding the prompt, so the second sample differs only by the model's own randomness.
  const userMessage = renderTailoringInput(payload.facts, job);

  const generated = await generateVerifiedTailoring(
    () =>
      deps.openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        response_format: { type: "json_object" },
        // See MODEL_MAX_OUTPUT_TOKENS: without this the SDK reserves the model's 16k maximum for
        // a response that runs about 1.5k.
        max_tokens: MODEL_MAX_OUTPUT_TOKENS,
      }),
    confirmedIds,
    { candidateId: input.candidateId, vacancyId: input.vacancyId, level, model },
  );

  // A model that grounded nothing at all has, in effect, declined to write a
  // resume. That is not an error to paper over with an empty document.
  const claims = allClaims(generated.content);
  if (claims.every((claim) => claim.text.trim().length === 0)) {
    throw new MalformedTailoredResumeError("every section came back empty, so there is nothing to submit");
  }

  return {
    kind: "generated",
    level,
    content: generated.content,
    modelVersion: model,
    promptVersion: RESUME_TAILORING_PROMPT_VERSION,
    citedFactCount: generated.citedFactCount,
  };
}

