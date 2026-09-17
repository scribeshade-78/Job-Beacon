/**
 * Response Intelligence Phase 2.1 — deterministic per-adapter JD text
 * extraction (Opportunity Intelligence PRD §11.1 "cleaned JD text with
 * section boundaries"). Pure, no I/O.
 *
 * Input is `vacancy_versions.raw_payload` — the verbatim provider object
 * each discovery adapter stores as `raw`. The adapter TypeScript
 * interfaces do not model the description/content fields (they only type
 * what discovery normalises), but the providers return them and `raw:` is
 * the whole object, so this module reads `raw_payload` as `unknown` and
 * narrows defensively: a missing field yields no section, never a throw.
 *
 * `cleanText` may legitimately be empty (Adzuna truncation, USAJOBS
 * summary-only search results). The worker treats an empty result as "no
 * JD text available" — it does NOT persist a snapshot and does NOT retry.
 */

export const JD_EXTRACTOR_VERSION = "jd-extract-v1";

export interface JdSection {
  heading: string | null;
  body: string;
}

export interface JdExtraction {
  cleanText: string;
  sections: JdSection[];
  htmlSnapshot: string | null;
  canonicalUrl: string | null;
}

export class UnknownJdSourceError extends Error {
  constructor(sourceCode: string) {
    super(`No JD extractor registered for source_code "${sourceCode}".`);
    this.name = "UnknownJdSourceError";
  }
}

// ---------------------------------------------------------------------------
// HTML -> text helpers (no new dependency — a narrow, documented subset).
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&rsquo;": "'",
  "&lsquo;": "'",
  "&rdquo;": '"',
  "&ldquo;": '"',
};

function decodeEntities(input: string): string {
  let out = input;
  for (const [entity, char] of Object.entries(NAMED_ENTITIES)) {
    out = out.split(entity).join(char);
  }
  // Numeric entities: &#123; and &#x1F;
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => safeFromCodePoint(parseInt(hex, 16)));
  out = out.replace(/&#(\d+);/g, (_m, dec) => safeFromCodePoint(parseInt(dec, 10)));
  return out;
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
    return "";
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function collapseWhitespace(input: string): string {
  return input
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Strip tags to plain text, turning block-level closes into newlines. */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|li|ul|ol|h[1-6]|section|tr|table)\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "• ");
  const noTags = withBreaks.replace(/<[^>]+>/g, "");
  return collapseWhitespace(decodeEntities(noTags));
}

/**
 * Split an HTML fragment into sections at <h1>..<h4> headings. Returns a
 * single unlabelled section when there are no headings. Content before the
 * first heading becomes an unlabelled leading section.
 */
export function htmlToSections(html: string): JdSection[] {
  const headingRe = /<\s*h[1-4][^>]*>([\s\S]*?)<\/\s*h[1-4]\s*>/gi;
  const sections: JdSection[] = [];
  let lastIndex = 0;
  let pendingHeading: string | null = null;
  let match: RegExpExecArray | null;

  while ((match = headingRe.exec(html)) !== null) {
    const bodyHtml = html.slice(lastIndex, match.index);
    const body = htmlToText(bodyHtml);
    if (body) {
      sections.push({ heading: pendingHeading, body });
    }
    pendingHeading = htmlToText(match[1] ?? "") || null;
    lastIndex = match.index + match[0].length;
  }

  const tailBody = htmlToText(html.slice(lastIndex));
  if (tailBody) {
    sections.push({ heading: pendingHeading, body: tailBody });
  } else if (pendingHeading) {
    sections.push({ heading: pendingHeading, body: "" });
  }

  if (sections.length === 0) {
    const whole = htmlToText(html);
    return whole ? [{ heading: null, body: whole }] : [];
  }
  return sections;
}

function sectionsToText(sections: JdSection[]): string {
  return sections
    .map((s) => (s.heading ? `${s.heading}\n${s.body}` : s.body))
    .join("\n\n")
    .trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// ---------------------------------------------------------------------------
// Per-adapter mappings.
// ---------------------------------------------------------------------------

function extractGreenhouse(raw: Record<string, unknown>): JdExtraction {
  // Greenhouse ?content=true returns `content` as an HTML-entity-escaped
  // string (HTML wrapped in one more layer of escaping).
  const contentRaw = asString(raw.content);
  const canonicalUrl = asString(raw.absolute_url);
  if (!contentRaw) {
    return { cleanText: "", sections: [], htmlSnapshot: null, canonicalUrl };
  }
  const html = decodeEntities(contentRaw);
  const sections = htmlToSections(html);
  return {
    cleanText: sectionsToText(sections),
    sections,
    htmlSnapshot: html,
    canonicalUrl,
  };
}

function extractLever(raw: Record<string, unknown>): JdExtraction {
  const canonicalUrl = asString(raw.hostedUrl);
  const descriptionHtml = asString(raw.description);
  const descriptionPlain = asString(raw.descriptionPlain);
  const lists = Array.isArray(raw.lists) ? raw.lists : [];

  const sections: JdSection[] = [];

  if (descriptionPlain) {
    sections.push({ heading: null, body: collapseWhitespace(descriptionPlain) });
  } else if (descriptionHtml) {
    sections.push(...htmlToSections(descriptionHtml));
  }

  for (const entry of lists) {
    const rec = asRecord(entry);
    const heading = asString(rec.text);
    const body = htmlToText(asString(rec.content) ?? "");
    if (heading || body) {
      sections.push({ heading, body });
    }
  }

  const htmlSnapshot =
    descriptionHtml || lists.length > 0
      ? [
          descriptionHtml ?? "",
          ...lists.map((e) => {
            const rec = asRecord(e);
            return `<h3>${asString(rec.text) ?? ""}</h3>${asString(rec.content) ?? ""}`;
          }),
        ]
          .join("\n")
          .trim()
      : null;

  return {
    cleanText: sectionsToText(sections),
    sections,
    htmlSnapshot: htmlSnapshot || null,
    canonicalUrl,
  };
}

function extractAdzuna(raw: Record<string, unknown>): JdExtraction {
  // Adzuna returns `description` as short, provider-truncated plain text.
  const description = asString(raw.description);
  const canonicalUrl = asString(raw.redirect_url);
  if (!description) {
    return { cleanText: "", sections: [], htmlSnapshot: null, canonicalUrl };
  }
  const body = collapseWhitespace(decodeEntities(description));
  return {
    cleanText: body,
    sections: body ? [{ heading: null, body }] : [],
    htmlSnapshot: null,
    canonicalUrl,
  };
}

function extractJooble(raw: Record<string, unknown>): JdExtraction {
  // Jooble's search response carries only `snippet` — a short, provider-
  // truncated plain-text preview ("This is a great opportunity to join our
  // team..."). There is no full description field on this endpoint, so this
  // resolves to short cleanText, the same class of limitation Adzuna's
  // truncated `description` has. `type`/`source` are metadata, not JD text.
  const snippet = asString(raw.snippet);
  const canonicalUrl = asString(raw.link);
  if (!snippet) {
    return { cleanText: "", sections: [], htmlSnapshot: null, canonicalUrl };
  }
  const body = collapseWhitespace(decodeEntities(snippet));
  return {
    cleanText: body,
    sections: body ? [{ heading: null, body }] : [],
    htmlSnapshot: null,
    canonicalUrl,
  };
}

const USAJOBS_DETAIL_FIELDS: Array<{ key: string; heading: string }> = [
  { key: "JobSummary", heading: "Summary" },
  { key: "MajorDutiesList", heading: "Duties" },
  { key: "QualificationSummary", heading: "Qualifications" },
  { key: "Education", heading: "Education" },
  { key: "Requirements", heading: "Requirements" },
  { key: "Evaluations", heading: "How You Will Be Evaluated" },
];

function extractUsajobs(raw: Record<string, unknown>): JdExtraction {
  // raw_payload for usajobs is the MatchedObjectDescriptor. Full JD text
  // lives under UserArea.Details, which the search endpoint only returns
  // with Fields=Full (an out-of-scope follow-up) — so this commonly
  // resolves to an empty result today.
  const canonicalUrl = asString(raw.PositionURI);
  const userArea = asRecord(raw.UserArea);
  const details = asRecord(userArea.Details);

  const sections: JdSection[] = [];
  for (const { key, heading } of USAJOBS_DETAIL_FIELDS) {
    const value = details[key];
    let body = "";
    if (typeof value === "string") {
      body = htmlToText(value);
    } else if (Array.isArray(value)) {
      body = value.map((v) => (typeof v === "string" ? `• ${htmlToText(v)}` : "")).filter(Boolean).join("\n");
    }
    if (body) {
      sections.push({ heading, body });
    }
  }

  return {
    cleanText: sectionsToText(sections),
    sections,
    htmlSnapshot: null,
    canonicalUrl,
  };
}

const EXTRACTORS: Record<string, (raw: Record<string, unknown>) => JdExtraction> = {
  greenhouse: extractGreenhouse,
  lever: extractLever,
  adzuna: extractAdzuna,
  usajobs: extractUsajobs,
  jooble: extractJooble,
};

/**
 * Map one `vacancy_versions.raw_payload` to cleaned JD text + section
 * boundaries. Throws only for an unregistered `sourceCode`; a payload with
 * no usable description field yields `{ cleanText: "", sections: [] }`.
 */
export function extractJd(sourceCode: string, rawPayload: unknown): JdExtraction {
  const extractor = EXTRACTORS[sourceCode];
  if (!extractor) {
    throw new UnknownJdSourceError(sourceCode);
  }
  return extractor(asRecord(rawPayload));
}
