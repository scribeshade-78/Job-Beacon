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

/**
 * What the popup needs to know about the session - never the token itself.
 *
 * THE ACCESS TOKEN IS DELIBERATELY ABSENT. The popup never handles a credential; it
 * asks the worker to perform the fetch and receives the result. Keeping the token in one
 * context means there is exactly one place that can leak it, and that place never renders
 * anything.
 */
export interface SessionInfo {
  signedIn: boolean;
  email: string;
}
