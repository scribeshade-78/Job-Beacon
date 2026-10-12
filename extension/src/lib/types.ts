/**
 * The subset of the candidate profile the form filler needs.
 *
 * DELIBERATELY SMALL. Every field here is one the extension will type into a third
 * party's page, so the list is the security boundary as much as a type: work
 * authorisation, salary expectations and visa answers are NOT here, because those are
 * questions a candidate must answer themselves on each application rather than have
 * broadcast automatically.
 */
export interface CandidateProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  linkedinUrl: string;
}

/** What the content script reports back, so the popup can show a real outcome. */
export interface FillReport {
  filled: string[];
  skipped: { field: string; reason: string }[];
}
