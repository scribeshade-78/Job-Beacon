import type { ApplicationAdapter } from "./types.js";
import { GREENHOUSE_SOURCE_CODE, greenhouseAdapter } from "./greenhouse.js";
import { LEVER_SOURCE_CODE, leverAdapter } from "./lever.js";
import { LOCAL_FIXTURE_SOURCE_CODE, localFixtureAdapter } from "./localFixture.js";
import { unsupportedAdapter } from "./unsupportedAdapter.js";

/**
 * Resolves a submission adapter by source_code — same "switch keyed by
 * source_code, default falls back" shape as
 * server/ingestion/ingest.ts's discoverForSource, reused instead of
 * inventing a Map-based or class-based registry (this codebase's
 * established convention). Deterministic: the same source_code always
 * resolves to the same adapter reference.
 *
 * Three real cases exist now (local_fixture, greenhouse, lever); everything else
 * falls through to unsupportedAdapter. The precondition this comment has always set
 * still governs adding more: a source needs BOTH an authorized submission
 * channel (employer credentials or a permitted hosted-form flow, PRD §16.2)
 * AND its own source_policies.automated_application_allowed = true. This
 * function is the seam, not a place to route work that has no authorized
 * destination.
 *
 * NOTE THAT REGISTERING AN ADAPTER ALONE CHANGES NOTHING. eligibilityGate.ts's
 * source_policy gate requires discovery_allowed AND
 * automated_application_allowed, so a source with no policy row — or one with
 * the flag false — still fails there even with an adapter wired here. The two
 * halves are independent on purpose: this file says "a channel exists", the
 * policy row says "we are authorized to use it".
 *
 * MP-A1: this function's own resolution logic is unchanged — the new
 * capability fields (isAutomatedSubmissionSupported/validateSupport) live
 * on each adapter, not here, so registering a real adapter is still just
 * adding one switch case with an object that satisfies ApplicationAdapter.
 */
export function resolveApplicationAdapter(sourceCode: string): ApplicationAdapter {
  switch (sourceCode) {
    // Mini-Phase 8: the first real case. It satisfies the precondition this
    // file's own doc comment sets — an authorized submission channel AND
    // source_policies.automated_application_allowed = true — for a source
    // whose channel is a local fixture that submits nowhere, which is the
    // only honest destination available today. See localFixture.ts.
    case LOCAL_FIXTURE_SOURCE_CODE:
      return localFixtureAdapter;
    // The first production channel: Greenhouse's documented Job Board API,
    // which the employer authorizes by issuing a Job Board API key for their
    // own board. Wiring it here makes application_support pass for greenhouse
    // vacancies; the source_policy gate still refuses them until a
    // source_policies row for greenhouse sets
    // automated_application_allowed = true. See greenhouse.ts.
    case GREENHOUSE_SOURCE_CODE:
      return greenhouseAdapter;
    // Task H3's second production channel: Lever's documented Postings API
    // ("POST /v0/postings/SITE/POSTING-ID?key=APIKEY"), authorized by an API key
    // a Lever Super Admin issues for their own account. Same two-halves rule as
    // above — this says a channel exists, and the source_policies row for lever
    // (which 20260917310000 derives from whether an active employer credential is
    // stored) says whether we may use it. See lever.ts.
    case LEVER_SOURCE_CODE:
      return leverAdapter;
    default:
      return unsupportedAdapter;
  }
}
