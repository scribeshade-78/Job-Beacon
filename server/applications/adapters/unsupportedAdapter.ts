import type { ApplicationAdapter } from "./types.js";

/**
 * PRD §16.2 "Unsupported/restricted" channel: "Skip or mark unsupported; do
 * not bypass restrictions." Every source_code resolves to this adapter
 * today (see registry.ts — no real per-source case exists yet), because no
 * source has source_policies.automated_application_allowed = true and no
 * per-source submission adapter exists anywhere in this repository.
 *
 * Throws a plain Error rather than returning a fabricated
 * ApplicationSubmissionResult — the same honest-failure discipline as
 * resumeGenerator.ts's NoConfirmedFactsError and this file's own
 * predecessor (submissionAdapter.ts's original always-throw stub). worker.ts
 * routes this through its generic failure path (evidence recorded, retried
 * with backoff, eventually dead-lettered), the same outcome the prior
 * always-throw stub already produced — this is a deliberately narrow
 * behavior change (real per-source resolution instead of an unconditional
 * throw) with the failure classification left exactly as it was.
 *
 * Not routed through ActionRequiredSubmissionError/'unsupported_portal':
 * that PRD §17 exception is for an individual application hitting a
 * portal quirk mid-submission (pause, resumable), a different situation
 * from "no source has an authorized channel yet" (a source-policy fact
 * true for every vacancy from that source, not a resumable one-off) —
 * conflating the two is a UX decision about the Action-Required queue this
 * mini-phase doesn't make unilaterally.
 */
export const unsupportedAdapter: ApplicationAdapter = {
  async submit(_client, context) {
    throw new Error(
      `No application adapter is registered for this vacancy's source (application attempt ${context.applicationAttemptId}) — PRD §16.2 channels are not implemented for any source yet.`,
    );
  },
};
