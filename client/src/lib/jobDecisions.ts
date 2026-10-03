import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Candidate-owned per-vacancy decisions: Save and Dismiss.
 *
 * PRECEDENCE LIVES HERE, IN ONE PURE FUNCTION. A vacancy can be both saved and
 * dismissed (the candidate saved it, then rejected it), and every consumer must
 * agree that dismissal wins. Deriving that in each panel is exactly how the feed
 * and a queue action would end up disagreeing about the same listing, so
 * isDismissed()/decisionStateOf() are the only place the rule is written.
 *
 * WRITES ARE REVERSIBLE. Save is insert/delete; Dismiss is insert/delete. Nothing
 * here touches the vacancy, an application plan or an attempt, so undo restores
 * the previous state and no application history is ever destroyed.
 *
 * NO RAW DATABASE TEXT. Every failure collapses to one candidate-facing
 * sentence, like every other client module in this directory.
 */

/** The CHECK-constrained reason vocabulary on dismissed_vacancies.reason. */
export const DISMISS_REASONS = [
  "not_interested",
  "wrong_role",
  "wrong_location",
  "wrong_seniority",
  "company",
  "other",
] as const;

export type DismissReason = (typeof DISMISS_REASONS)[number];

export const DISMISS_REASON_LABELS: Record<DismissReason, string> = {
  not_interested: "Not interested",
  wrong_role: "Wrong kind of role",
  wrong_location: "Wrong location",
  wrong_seniority: "Wrong seniority",
  company: "Not interested in this company",
  other: "Something else",
};

export function isDismissReason(value: unknown): value is DismissReason {
  return typeof value === "string" && (DISMISS_REASONS as readonly string[]).includes(value);
}

export interface DismissedVacancy {
  vacancyId: string;
  reason: DismissReason;
  note: string | null;
  dismissedAt: string;
}

/**
 * Everything the UI needs to render one listing's decision state without a
 * per-card query.
 */
export interface VacancyDecisions {
  savedIds: ReadonlySet<string>;
  dismissed: ReadonlyMap<string, DismissedVacancy>;
}

export const EMPTY_DECISIONS: VacancyDecisions = { savedIds: new Set(), dismissed: new Map() };

export type DecisionState = "none" | "saved" | "dismissed" | "saved_and_dismissed";

/**
 * THE PRECEDENCE RULE. Dismissal wins: a decided-against vacancy is excluded
 * from the feed and from eligibility even when a save row also exists, until the
 * dismissal itself is undone.
 */
export function isDismissed(decisions: VacancyDecisions, vacancyId: string): boolean {
  return decisions.dismissed.has(vacancyId);
}

export function isSaved(decisions: VacancyDecisions, vacancyId: string): boolean {
  return decisions.savedIds.has(vacancyId);
}

export function decisionStateOf(decisions: VacancyDecisions, vacancyId: string): DecisionState {
  const dismissed = isDismissed(decisions, vacancyId);
  const saved = isSaved(decisions, vacancyId);

  if (dismissed && saved) {
    return "saved_and_dismissed";
  }
  if (dismissed) {
    return "dismissed";
  }
  if (saved) {
    return "saved";
  }
  return "none";
}

/**
 * The ids a feed query must exclude. Returns dismissed ids ONLY, in a stable
 * order, so the emitted PostgREST clause is deterministic and cacheable.
 */
export function excludedFromFeed(decisions: VacancyDecisions): string[] {
  return [...decisions.dismissed.keys()].sort();
}

const LIST_FAILURE_MESSAGE = "Could not load your saved and dismissed jobs. Please try again.";
const MUTATE_FAILURE_MESSAGE = "Could not update this job. Please try again.";
const POSTGRES_UNIQUE_VIOLATION = "23505";

export type ListDecisionsResult =
  | { kind: "success"; decisions: VacancyDecisions }
  | { kind: "error"; message: string };

/**
 * Reads both tables. RLS already scopes every row to the signed-in candidate, so
 * no candidate_id predicate is passed here — unlike the service-role readers in
 * server/applications/dismissalGate.ts, which must scope explicitly.
 */
export async function listVacancyDecisions(
  client: Pick<SupabaseClient, "from">,
): Promise<ListDecisionsResult> {
  try {
    const [savedResult, dismissedResult] = await Promise.all([
      client.from("saved_vacancies").select("vacancy_id"),
      client.from("dismissed_vacancies").select("vacancy_id, reason, note, dismissed_at"),
    ]);

    if (savedResult.error || dismissedResult.error || !savedResult.data || !dismissedResult.data) {
      return { kind: "error", message: LIST_FAILURE_MESSAGE };
    }

    const savedIds = new Set<string>(
      (savedResult.data as Array<{ vacancy_id: string }>).map((row) => row.vacancy_id),
    );

    const dismissed = new Map<string, DismissedVacancy>();

    for (const row of dismissedResult.data as Array<{
      vacancy_id: string;
      reason: string;
      note: string | null;
      dismissed_at: string;
    }>) {
      // A reason this build does not recognise still counts as a dismissal:
      // treating an unknown reason as "not dismissed" would silently re-admit a
      // vacancy the candidate explicitly rejected.
      dismissed.set(row.vacancy_id, {
        vacancyId: row.vacancy_id,
        reason: isDismissReason(row.reason) ? row.reason : "other",
        note: row.note,
        dismissedAt: row.dismissed_at,
      });
    }

    return { kind: "success", decisions: { savedIds, dismissed } };
  } catch {
    return { kind: "error", message: LIST_FAILURE_MESSAGE };
  }
}

export type VacancyDecisionResult = { kind: "success" } | { kind: "error"; message: string };

/** Save. Already-saved is success, matching setExclusion's idempotent-on-duplicate pattern. */
export async function saveVacancy(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
  vacancyId: string,
): Promise<VacancyDecisionResult> {
  try {
    const { error } = await client
      .from("saved_vacancies")
      .insert({ candidate_id: candidateId, vacancy_id: vacancyId });

    if (error && error.code !== POSTGRES_UNIQUE_VIOLATION) {
      return { kind: "error", message: MUTATE_FAILURE_MESSAGE };
    }

    return { kind: "success" };
  } catch {
    return { kind: "error", message: MUTATE_FAILURE_MESSAGE };
  }
}

export async function unsaveVacancy(
  client: Pick<SupabaseClient, "from">,
  vacancyId: string,
): Promise<VacancyDecisionResult> {
  try {
    const { error } = await client.from("saved_vacancies").delete().eq("vacancy_id", vacancyId);

    if (error) {
      return { kind: "error", message: MUTATE_FAILURE_MESSAGE };
    }

    return { kind: "success" };
  } catch {
    return { kind: "error", message: MUTATE_FAILURE_MESSAGE };
  }
}

/**
 * Dismiss. Deliberately does NOT delete a matching saved row: see the module
 * header. Re-dismissing an already-dismissed vacancy is success and leaves the
 * original reason and timestamp intact (the row is evidence of the first
 * decision; silently rewriting its reason would be the opposite).
 */
export async function dismissVacancy(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
  vacancyId: string,
  reason: DismissReason,
  note: string | null,
): Promise<VacancyDecisionResult> {
  const trimmed = (note ?? "").trim();

  try {
    const { error } = await client.from("dismissed_vacancies").insert({
      candidate_id: candidateId,
      vacancy_id: vacancyId,
      reason,
      note: trimmed === "" ? null : trimmed,
    });

    if (error && error.code !== POSTGRES_UNIQUE_VIOLATION) {
      return { kind: "error", message: MUTATE_FAILURE_MESSAGE };
    }

    return { kind: "success" };
  } catch {
    return { kind: "error", message: MUTATE_FAILURE_MESSAGE };
  }
}

/** Undo. A delete, so it restores exactly the prior state — including a save. */
export async function undoDismissal(
  client: Pick<SupabaseClient, "from">,
  vacancyId: string,
): Promise<VacancyDecisionResult> {
  try {
    const { error } = await client.from("dismissed_vacancies").delete().eq("vacancy_id", vacancyId);

    if (error) {
      return { kind: "error", message: MUTATE_FAILURE_MESSAGE };
    }

    return { kind: "success" };
  } catch {
    return { kind: "error", message: MUTATE_FAILURE_MESSAGE };
  }
}
