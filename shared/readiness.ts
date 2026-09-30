/**
 * Setup readiness and automation gating — ONE pure rule, shared by the Home UI
 * and the server.
 *
 * WHY THIS LIVES IN shared/. tsconfig.server.json includes only ["server",
 * "shared"], so the server cannot import a client module — and the exact failure
 * this task fixes is two surfaces disagreeing about whether automation may run.
 * Same reasoning, and the same location, as shared/pipelineStages.ts.
 *
 * WHAT WAS WRONG BEFORE. The Home card showed "Authorized" (and, before that,
 * "Active") purely because a row existed in automation_authorizations. That row
 * records SUBMISSION CONSENT. It says nothing about whether a resume exists,
 * whether a resume could be read, whether any target role is selected, whether
 * search preferences were ever saved, or whether any job source can carry an
 * application. A brand-new candidate with no resume saw a green "Authorized"
 * badge and live Pause/Stop controls next to a submission pipeline that could
 * not run. Every one of those inputs is evaluated here instead.
 *
 * TWO SEPARATE DIMENSIONS, DELIBERATELY KEPT APART:
 *
 *   setup readiness   — four steps the candidate completes (resume, roles,
 *                       preferences, consent)
 *   capability        — whether the PRODUCT can carry an application at all
 *                       (an authorized source with a supported adapter)
 *
 * A candidate can be fully set up while the product cannot submit for anybody.
 * That is the current production state, and collapsing the two is what produced
 * the original lie.
 *
 * FAIL CLOSED. Absent, null or unrecognised input never yields readiness. A
 * malformed resume status is not "probably fine", an unknown consent status is
 * not "authorized", and a preference row that was never saved is not complete.
 * The caller distinguishes "still loading" from "answered" itself; this module
 * never has to guess.
 */

/** The parse states resume_documents.parse_status can hold. */
export const RESUME_PARSE_STATUSES = ["uploaded", "parsing", "parsed", "failed"] as const;

export type ResumeParseStatus = (typeof RESUME_PARSE_STATUSES)[number];

export function isResumeParseStatus(value: unknown): value is ResumeParseStatus {
  return typeof value === "string" && (RESUME_PARSE_STATUSES as readonly string[]).includes(value);
}

/** The consent states automation_authorizations.status can hold. There is no expiry in the schema. */
export const CONSENT_STATUSES = ["authorized", "paused", "stopped"] as const;

export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export function isConsentStatus(value: unknown): value is ConsentStatus {
  return typeof value === "string" && (CONSENT_STATUSES as readonly string[]).includes(value);
}

/**
 * Work-mode values that count as an explicit preference.
 *
 * Mirrors candidate_preferences.remote_preference's CHECK constraint
 * ('remote' | 'hybrid' | 'on_site' | 'any'). NULL is "not stated" and is NOT a
 * value in this list — the column comment in 20260917340000 draws that line and
 * this is the code half of it.
 */
export const EXPLICIT_REMOTE_PREFERENCES = ["remote", "hybrid", "on_site", "any"] as const;

export interface ReadinessResumeInput {
  /** resume_documents.parse_status, as read from the database. */
  status: unknown;
}

export interface ReadinessPreferencesInput {
  /**
   * True only when a candidate_preferences ROW exists.
   *
   * Row existence is the saved signal: the primary key is candidate_id and the
   * only writer is an explicit save from the preferences form, so a row cannot
   * appear without the candidate having submitted one.
   */
  saved: boolean;
  remotePreference: unknown;
  countryCount: number;
  cityCount: number;
  openToAnyLocation: unknown;
}

export interface ReadinessInput {
  /** The candidate's most recent UPLOADED resume (kind = 'uploaded'), or null. */
  resume: ReadinessResumeInput | null;
  targetRoleCount: number;
  preferences: ReadinessPreferencesInput | null;
  /** automation_authorizations.status, or null when no row exists. */
  consentStatus: unknown;
  /** From GET /api/opportunities/capability: an authorized source with a supported adapter. */
  canQueue: boolean;
  /** candidate_profiles.review_before_submit — held attempts await approval when true. */
  reviewBeforeSubmit: boolean;
  /**
   * Whether a scheduled process is genuinely executing automation.
   *
   * NO CODE SETS THIS TRUE TODAY: the scheduler runs no application automation
   * (verified in server/scheduler.ts) and no source can queue. It exists so that
   * 'active' is reachable only on evidence rather than on configuration, and it
   * is the reason 'active' is currently unreachable — which is the honest state
   * of the product, not an oversight.
   */
  scheduledAutomationRunning: boolean;
}

export type ReadinessBlockerCode =
  | "resume_missing"
  | "resume_parsing"
  | "resume_parse_failed"
  | "target_roles_missing"
  | "search_preferences_incomplete"
  | "submission_consent_missing"
  | "supported_source_missing"
  | "submission_adapter_missing"
  | "automation_paused"
  | "automation_stopped";

export interface ReadinessAction {
  label: string;
  /**
   * The app route that resolves this blocker, or null when the action is handled
   * inside the readiness card itself. Consent has no dedicated route — the
   * authorize/withdraw controls live on the card — so it is the null case.
   */
  route: string | null;
}

export interface ReadinessBlocker {
  code: ReadinessBlockerCode;
  /** Candidate-facing sentence. Never a schema, table or column name. */
  message: string;
  action: ReadinessAction | null;
}

/**
 * Setup steps, in the order the checklist renders them. Four, and the completion
 * count the card shows is derived from these — not restated anywhere.
 */
export const SETUP_STEPS = ["resume", "target_roles", "search_preferences", "submission_consent"] as const;

export type SetupStepId = (typeof SETUP_STEPS)[number];

export interface SetupStep {
  id: SetupStepId;
  label: string;
  complete: boolean;
  /** Why it is not complete, or a confirmatory sentence when it is. */
  detail: string;
  action: ReadinessAction | null;
  /** ISO timestamp relevant to this step, when the data model actually has one. */
  timestamp: string | null;
}

export type PrimaryState =
  | "setup_incomplete"
  | "discovery_ready"
  | "submission_consent_missing"
  | "blocked_no_supported_source"
  | "ready_for_review_queue"
  | "automation_paused"
  | "active"
  | "stopped";

export interface Readiness {
  resumeReady: boolean;
  rolesReady: boolean;
  preferencesReady: boolean;
  consentReady: boolean;
  completedSteps: number;
  totalSteps: number;
  setupComplete: boolean;
  /** Roles + preferences are sufficient to run personalized job discovery. */
  discoveryAvailable: boolean;
  /** An application can be queued for review. */
  reviewQueueAvailable: boolean;
  /** An application can actually be submitted. */
  submissionAvailable: boolean;
  /** Pause/Resume/Stop would act on something real. */
  automationControlsAvailable: boolean;
  blockers: ReadinessBlocker[];
  primaryState: PrimaryState;
  steps: SetupStep[];
}

const RESUME_ACTION: ReadinessAction = { label: "Upload resume", route: "/resumes" };
const ROLES_ACTION: ReadinessAction = { label: "Choose target roles", route: "/target-roles" };
const PREFERENCES_ACTION: ReadinessAction = { label: "Complete search preferences", route: "/profile" };
const CONSENT_ACTION: ReadinessAction = { label: "Review submission consent", route: null };

/** Whether the resume step is satisfied. Only a successfully parsed upload counts. */
export function resumeStepComplete(resume: ReadinessResumeInput | null): boolean {
  return resume !== null && resume.status === "parsed";
}

/**
 * The candidate-facing reason a resume step is not yet complete.
 *
 * Exported because the Resumes page needs the same sentences as the checklist —
 * one definition of "why is this not ready", so the two cannot drift.
 */
export function resumeStepDetail(resume: ReadinessResumeInput | null): string {
  if (resume === null) {
    return "Upload a resume";
  }

  // An unrecognised value is treated as unprocessed rather than as success:
  // a status this build does not understand cannot justify calling it ready.
  if (!isResumeParseStatus(resume.status)) {
    return "Resume uploaded · Waiting to be processed";
  }

  switch (resume.status) {
    case "uploaded":
      return "Resume uploaded · Waiting to be processed";
    case "parsing":
      return "Resume parsing in progress";
    case "parsed":
      return "Resume parsed and ready";
    case "failed":
      return "Resume parsing failed · Review or retry";
  }
}

/** Blockers contributed by the resume step, if any. */
function resumeBlockers(resume: ReadinessResumeInput | null): ReadinessBlocker[] {
  if (resumeStepComplete(resume)) {
    return [];
  }

  const message = resumeStepDetail(resume);

  if (resume === null || !isResumeParseStatus(resume.status)) {
    return [{ code: "resume_missing", message, action: RESUME_ACTION }];
  }

  switch (resume.status) {
    case "uploaded":
      return [{ code: "resume_missing", message, action: RESUME_ACTION }];
    case "parsing":
      return [{ code: "resume_parsing", message, action: RESUME_ACTION }];
    case "failed":
      return [{ code: "resume_parse_failed", message, action: RESUME_ACTION }];
    case "parsed":
      return [];
  }
}

/**
 * Whether the location intent is explicit.
 *
 * Two acceptable shapes, and NOTHING else: at least one named country or city,
 * or the explicit "open to any location" flag. An empty list with the flag false
 * is "not stated" and is not complete — that is the whole point of the flag.
 */
export function locationIntentExplicit(preferences: ReadinessPreferencesInput): boolean {
  if (preferences.openToAnyLocation === true) {
    return true;
  }

  return preferences.countryCount > 0 || preferences.cityCount > 0;
}

export function workModeExplicit(preferences: ReadinessPreferencesInput): boolean {
  return (
    typeof preferences.remotePreference === "string" &&
    (EXPLICIT_REMOTE_PREFERENCES as readonly string[]).includes(preferences.remotePreference)
  );
}

export function preferencesStepComplete(preferences: ReadinessPreferencesInput | null): boolean {
  if (preferences === null || preferences.saved !== true) {
    return false;
  }

  return workModeExplicit(preferences) && locationIntentExplicit(preferences);
}

function preferencesBlockers(preferences: ReadinessPreferencesInput | null): ReadinessBlocker[] {
  if (preferencesStepComplete(preferences)) {
    return [];
  }

  return [
    {
      code: "search_preferences_incomplete",
      message: "Tell us where you want to work and whether you want remote, hybrid or on-site roles.",
      action: PREFERENCES_ACTION,
    },
  ];
}

function consentBlockers(consentStatus: unknown): ReadinessBlocker[] {
  if (consentStatus === null || consentStatus === undefined || !isConsentStatus(consentStatus)) {
    return [
      {
        code: "submission_consent_missing",
        message: "Submission consent not granted",
        action: CONSENT_ACTION,
      },
    ];
  }

  if (consentStatus === "paused") {
    return [{ code: "automation_paused", message: "Automation paused", action: CONSENT_ACTION }];
  }

  if (consentStatus === "stopped") {
    return [{ code: "automation_stopped", message: "Automation stopped", action: CONSENT_ACTION }];
  }

  return [];
}
/**
 * Evaluates readiness. Pure: no I/O, no clock, no environment.
 *
 * PRECEDENCE, and where it departs from the suggested order:
 *
 * The suggested order placed submission_consent_missing before the paused and
 * stopped states, which makes both unreachable — a paused consent is by
 * definition not "authorized", so it would always be reported as missing consent
 * and a candidate who deliberately paused would be told their consent was never
 * given. Verified backend behaviour is why this is adjusted, as permitted:
 * pause/stop revoke authorization and cancel claimable attempts
 * (20260820150000's claim_application_attempt), so they are real, deliberate
 * states that the UI must be able to show.
 *
 * The rule that makes it safe: paused/stopped are reported ONLY when the other
 * three setup steps are complete. A candidate who paused and also has no resume
 * still sees setup_incomplete with the missing resume, so consent state can
 * never hide a setup blocker.
 *
 * discovery_ready is carried in PrimaryState because the product vocabulary
 * names it, but per the same precedence rule it is not returned: when roles and
 * preferences are ready and the resume is not, setup_incomplete wins. The
 * underlying capability is exposed as discoveryAvailable, which is what the
 * Find Jobs surface actually consumes.
 */
export function evaluateReadiness(input: ReadinessInput): Readiness {
  const resumeReady = resumeStepComplete(input.resume);
  const rolesReady = input.targetRoleCount > 0;
  const preferencesReady = preferencesStepComplete(input.preferences);

  const recognizedConsent = isConsentStatus(input.consentStatus) ? input.consentStatus : null;
  const consentGranted = recognizedConsent !== null;
  const consentReady = recognizedConsent === "authorized";

  // The three steps that are NOT consent. Used to decide whether a paused or
  // stopped consent may be reported as the primary state.
  const nonConsentStepsComplete = resumeReady && rolesReady && preferencesReady;

  // SETUP COMPLETE REQUIRES *VALID* CONSENT, not merely a consent row.
  // consentGranted (a row exists) is what makes the paused and stopped states
  // reachable at all — but a paused or stopped consent has been WITHDRAWN, so it
  // must not count as a finished setup: that is what refuses a queue request.
  const setupComplete = nonConsentStepsComplete && consentReady;

  const discoveryAvailable = rolesReady && preferencesReady;
  const reviewQueueAvailable = setupComplete && consentReady && input.canQueue;
  const submissionAvailable = reviewQueueAvailable;
  const automationControlsAvailable = setupComplete && consentReady && input.canQueue;

  const blockers: ReadinessBlocker[] = [
    ...resumeBlockers(input.resume),
    ...(rolesReady
      ? []
      : [
          {
            code: "target_roles_missing" as const,
            message: "Choose at least one target role so we know what to look for.",
            action: ROLES_ACTION,
          },
        ]),
    ...preferencesBlockers(input.preferences),
    ...consentBlockers(input.consentStatus),
  ];

  // Capability blockers are reported only once the candidate has done everything
  // they can: telling someone no source supports submission while their resume is
  // still missing would bury the step they can actually take.
  if (setupComplete && !input.canQueue) {
    blockers.push({
      code: "supported_source_missing",
      message:
        "No available job source currently supports automatic applications. You can continue finding and reviewing jobs manually.",
      action: null,
    });
  }

  let primaryState: PrimaryState;

  if (!nonConsentStepsComplete) {
    primaryState = "setup_incomplete";
  } else if (recognizedConsent === "paused") {
    primaryState = "automation_paused";
  } else if (recognizedConsent === "stopped") {
    primaryState = "stopped";
  } else if (!consentGranted) {
    primaryState = "submission_consent_missing";
  } else if (!input.canQueue) {
    primaryState = "blocked_no_supported_source";
  } else if (input.scheduledAutomationRunning) {
    primaryState = "active";
  } else {
    // Setup complete, consent authorized, a capable source exists, nothing
    // scheduled. This is the truthful ceiling: the review queue is where work
    // would land. reviewBeforeSubmit decides whether it waits for approval, and
    // is reflected in the copy rather than in a fifth state the product has not
    // defined.
    primaryState = "ready_for_review_queue";
  }

  const steps: SetupStep[] = [
    {
      id: "resume",
      label: "Resume",
      complete: resumeReady,
      detail: resumeStepDetail(input.resume),
      action: resumeReady ? null : RESUME_ACTION,
      timestamp: null,
    },
    {
      id: "target_roles",
      label: "Target roles",
      complete: rolesReady,
      detail: rolesReady
        ? input.targetRoleCount + (input.targetRoleCount === 1 ? " role selected" : " roles selected")
        : "No target roles selected",
      action: rolesReady ? null : ROLES_ACTION,
      timestamp: null,
    },
    {
      id: "search_preferences",
      label: "Search preferences",
      complete: preferencesReady,
      detail: preferencesReady
        ? "Location and work mode saved"
        : "Location and work mode not saved yet",
      action: preferencesReady ? null : PREFERENCES_ACTION,
      timestamp: null,
    },
    {
      id: "submission_consent",
      label: "Submission consent",
      complete: consentGranted,
      detail: consentGranted ? "Submission consent granted" : "Submission consent not granted",
      action: consentGranted ? null : CONSENT_ACTION,
      timestamp: null,
    },
  ];

  const completedSteps = steps.filter((step) => step.complete).length;

  return {
    resumeReady,
    rolesReady,
    preferencesReady,
    consentReady,
    completedSteps,
    totalSteps: SETUP_STEPS.length,
    setupComplete,
    discoveryAvailable,
    reviewQueueAvailable,
    submissionAvailable,
    automationControlsAvailable,
    blockers,
    primaryState,
    steps,
  };
}

/**
 * The card's headline. Uses the exact product copy, and states the limitation
 * rather than implying a capability.
 */
export function readinessHeadline(readiness: Readiness): string {
  switch (readiness.primaryState) {
    case "setup_incomplete":
      return "Setup incomplete · " + readiness.completedSteps + " of " + readiness.totalSteps + " complete";
    case "submission_consent_missing":
      return "Ready to search · Submission consent required";
    case "blocked_no_supported_source":
      return "Setup complete · Automatic submission unavailable";
    case "ready_for_review_queue":
      return "Ready for application review";
    case "automation_paused":
      return "Automation paused";
    case "stopped":
      return "Automation stopped";
    case "active":
      return "Automation active";
    case "discovery_ready":
      return "Ready to search";
  }
}
