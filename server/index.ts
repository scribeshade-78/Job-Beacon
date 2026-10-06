import express from "express";
import rateLimit from "express-rate-limit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME, HEALTH_PATH, type HealthResponse } from "../shared/app.js";
import {
  createRequireAuth,
  type AccessTokenVerifier,
  type AuthenticatedRequest,
} from "./requireAuth.js";
import { isModerator, type ModeratorChecker } from "./requireModerator.js";
import { createRequireAdmin, isAdmin, type AdminChecker } from "./requireAdmin.js";
import { createRequireModeratorOrAdmin } from "./requireModeratorOrAdmin.js";
import { createRequireWorkerSecret } from "./requireWorkerSecret.js";
import { getAdminOverview } from "./admin/overview.js";
import {
  listSourcePolicies,
  updateSourcePolicy,
  EDITABLE_SOURCE_POLICY_FIELDS,
  SourcePolicyNotFoundError,
  type EditableSourcePolicyField,
} from "./admin/sources.js";
import { getRecentTrustScores } from "./admin/trustScores.js";
import { getAdminBilling } from "./admin/billing.js";
import {
  findUserByEmail,
  grantRole,
  isManageableRole,
  listRoleAssignments,
  MANAGEABLE_ROLES,
  revokeRole,
} from "./admin/roles.js";
import {
  isSourceHealthStatus,
  listSourceHealthEvents,
  SOURCE_HEALTH_STATUSES,
} from "./admin/sourceHealth.js";
import {
  isQueueName,
  listQueues,
  QUEUE_NAMES,
  rearmFailedJob,
} from "./admin/queues.js";
import {
  ADMIN_WORKER_TASKS,
  isAdminWorkerTask,
  runAdminWorkerTask,
  WorkerTaskNotConfiguredError,
} from "./admin/workerTasks.js";
import {
  BILLING_REGIONS,
  findActivePrice,
  isBillingInterval,
  isBillingRegion,
  listPlans,
} from "./billing/plans.js";
import {
  createCheckoutSession,
  readStripeConfig,
  verifyStripeSignature,
} from "./billing/stripe.js";
import {
  createRazorpayOrder,
  fetchRazorpayOrder,
  readRazorpayConfig,
  verifyRazorpayCallbackSignature,
  verifyRazorpayWebhookSignature,
} from "./billing/razorpay.js";
import { selectCandidatePlan } from "./billing/selectPlan.js";
import { REGION_CURRENCY } from "../shared/pricing.js";
import {
  applyCheckoutCompleted,
  applyProviderSubscriptionUpdate,
  cancelCandidateSubscription,
  getCandidateSubscription,
} from "./billing/subscription.js";
import { evaluateEntitlements } from "./billing/entitlements.js";
import { listAuditEvents, recordAuditEvent } from "./audit/log.js";
import { listSecurityEvents } from "./security/events.js";
import {
  listAtsCredentials,
  setAtsCredentialActive,
  storeAtsCredential,
  ATS_SOURCE_CODES,
  AtsCredentialKeyError,
  type AtsSourceCode,
} from "./ats/credentials.js";
import { DIMENSION_WEIGHTS } from "./trust/trustScore.js";
import { createSupabaseServiceRoleClient } from "./supabaseServiceRole.js";
import { createOpenAIClient } from "./resumes/openaiClient.js";
import { extractResumeFacts } from "./resumes/extractFacts.js";
import { prepareInterviewPrep } from "./interview/interviewPrep.js";
import { runApplicationBatch } from "./applications/runner.js";
import { runMessageClassificationBatch } from "./mailbox/classifyBatch.js";
import { runApplicationMatchBatch } from "./mailbox/matchBatch.js";
import { runFitAnalysisBatch } from "./opportunities/runner.js";
import { runRankingRefresh } from "./opportunities/rankingRefresh.js";
import { answerAgentChat, parseAgentChatRequest } from "./agent/chat.js";
import { executeAgentAction, parseAgentActionRequest } from "./agent/actions.js";
import {
  AGENT_ACTION_RATE_LIMIT_MAX,
  AGENT_ACTION_RATE_LIMIT_WINDOW_MS,
  AGENT_RATE_LIMIT_MAX,
  AGENT_RATE_LIMIT_WINDOW_MS,
} from "../shared/agent.js";

/**
 * Task A2: how much fit analysis one "Fetch latest jobs" press may trigger.
 *
 * Each analysis is two model calls (JD extraction, then the fit itself), so the
 * bound is what keeps a candidate's button from becoming an unbounded spend —
 * the same reasoning as MAX_BULK_APPLY_VACANCIES and the per-batch caps the
 * other workers already have. A run that creates more than this leaves the rest
 * queued; the response says how many, and the UI says so too rather than
 * implying every new job was scored.
 */
const MAX_FIT_ANALYSES_PER_DISCOVERY = 5;

/**
 * Wall-clock ceiling for that batch.
 *
 * The count bound alone is not enough for a request-scoped batch: five
 * analyses at roughly ten seconds each is close to a minute of a held-open
 * HTTP request. Analyses already started are never abandoned — this stops the
 * batch from starting more — so the response reports what was scored and what
 * was left queued rather than pretending the work finished.
 */
const FIT_ANALYSIS_BUDGET_MS = 45_000;
import { runIngestionBatch } from "./ingestion/runner.js";
import { bulkApplyToVacancies, MAX_BULK_APPLY_VACANCIES } from "./applications/bulkApply.js";
import { loadQueueCapability } from "./applications/queueCapability.js";
import { loadCandidateReadiness, setupRefusals } from "./applications/readinessGate.js";
import {
  approveAttempt,
  approveOwnedAttempt,
  AttemptNotAwaitingReviewError,
  AttemptNotOwnedError,
  AttemptNotPreviewedError,
  ApplicationAttemptNotFoundError,
  generateAttemptPreview,
} from "./applications/attemptReview.js";
import { isMockEmployerEnabled, mountMockEmployer } from "./mockEmployer.js";
import { listIntakeAdapters } from "./intake/adapters/registry.js";
import {
  dismissFollowUpDraft,
  FollowUpDraftNotFoundError,
  FollowUpDraftNotOwnedError,
  FollowUpDraftNotPendingError,
  listPendingFollowUps,
  sendFollowUpDraft,
} from "./mailbox/followUpReview.js";
import { IntakePolicyError, runIntake, runIntakeAcrossSources } from "./intake/intake.js";
import { loadIntakeQueryContext } from "./intake/queryContext.js";
import { submitVacancyReport, REPORT_CATEGORIES, type ReportCategory } from "./reports.js";
import { getModerationQueue } from "./moderation/queue.js";
import {
  submitModerationDecision,
  ReviewerSeparationError,
  MODERATION_DECISIONS,
  type ModerationDecisionValue,
} from "./moderation/decisions.js";
import {
  startMailboxConnect,
  completeMailboxConnect,
  disconnectMailboxConnection,
  InvalidOAuthStateError,
  MailboxConnectionNotFoundError,
} from "./mailbox/connect.js";
import { readGoogleOAuthConfig, type GoogleOAuthConfig } from "./mailbox/oauth.js";
import { readMailboxEncryptionKey } from "./mailbox/tokenCrypto.js";
import { readMailboxCapability } from "./mailbox/capability.js";
import {
  createRequireEmployerOf,
  hasVerifiedEmployerClaim,
  isVerifiedEmployerOf,
  type EmployerChecker,
  type HasVerifiedEmployerClaimChecker,
} from "./requireEmployer.js";
import {
  submitEmployerClaim,
  getEmployerClaimsQueue,
  submitEmployerClaimDecision,
  CompanyNotFoundError,
  EMPLOYER_CLAIM_DECISIONS,
  type EmployerClaimDecisionValue,
} from "./employer/claims.js";
import {
  submitCompanyFactCorrection,
  getCompanyFactCorrectionsQueue,
  submitCorrectionDecision,
  isCorrectableField,
  InvalidProposedValueError,
  UnverifiedEmployerError,
  CorrectionNotFoundError,
  CORRECTION_DECISIONS,
  type CorrectionDecisionValue,
} from "./employer/corrections.js";
import {
  listEmployerBlockedVacancies,
  submitVacancyAppeal,
  getAppealsQueue,
  UnverifiedEmployerError as UnverifiedEmployerAppealError,
  VacancyNotFoundError,
  DuplicatePendingAppealError,
} from "./employer/appeals.js";

export interface CreateAppOptions {
  verifyAccessToken?: AccessTokenVerifier;
  checkIsModerator?: ModeratorChecker;
  /** Injectable for tests; resolved lazily per-request otherwise (see each route) — never constructed eagerly, since SUPABASE_SERVICE_ROLE_KEY isn't set in every environment. */
  serviceClient?: SupabaseClient;
  /** Injectable for tests; resolved lazily per-request otherwise — never constructed eagerly, since OPENAI_API_KEY isn't set in every environment. */
  openaiClient?: Pick<OpenAI, "chat">;
  /** Injectable for tests; defaults to process.env.WORKER_TRIGGER_SECRET (MP-W2) — undefined means the route is unreachable (500), not open. */
  workerSecret?: string;
  /** Injectable for tests; resolved lazily per-request otherwise via readGoogleOAuthConfig() — undefined env vars mean the route 500s rather than silently misconfiguring the OAuth flow. */
  googleOAuthConfig?: GoogleOAuthConfig;
  /** Injectable for tests; defaults to process.env.MAILBOX_OAUTH_STATE_SECRET (R6.1) — signs/verifies the callback's `state` param. */
  mailboxOAuthStateSecret?: string;
  /** Injectable for tests; resolved lazily via readMailboxEncryptionKey() otherwise (R6.1) — the AES-256-GCM key mailbox OAuth tokens are encrypted under before storage. */
  mailboxEncryptionKey?: Buffer;
  /** Injectable for tests; defaults to process.env.CLIENT_APP_URL (R6.1) — base origin the OAuth callback redirects back to. Empty string is a valid default: in production the server serves the client from the same origin, so a relative redirect is correct. */
  mailboxClientAppUrl?: string;
  /** Injectable for tests (R5.4a) — same "server-verified UX signal only" role as checkIsModerator. */
  checkHasVerifiedEmployerClaim?: HasVerifiedEmployerClaimChecker;
  /** Injectable for tests (R5.4b) — the real per-company authorization boundary requireEmployerOf enforces. */
  checkIsVerifiedEmployer?: EmployerChecker;
  /** Injectable for tests (R8.1) — same "UX signal only" role checkIsModerator carries for /api/me; requireAdmin below is the real authorization boundary. */
  checkIsAdmin?: AdminChecker;
  /** Injectable for tests; defaults to <cwd>/dist/client. The built client served statically, and the directory the SPA fallback resolves index.html from. */
  clientBuildPath?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Strict `?limit=` parsing shared by the newest-N admin log routes.
 *
 * Deliberately Number + Number.isInteger rather than Number.parseInt: parseInt
 * accepts "12abc" as 12 and leaves NaN for "abc", and a NaN reaches PostgREST as
 * an unparseable range rather than an error anyone can act on. An absent value
 * is a valid "use the default", not an invalid one.
 */
function parseLimitQuery(raw: unknown): { ok: true; limit: number | undefined } | { ok: false } {
  if (raw === undefined) {
    return { ok: true, limit: undefined };
  }

  const parsed = typeof raw === "string" ? Number(raw) : Number.NaN;

  if (!Number.isInteger(parsed) || parsed < 1) {
    return { ok: false };
  }

  return { ok: true, limit: parsed };
}

/** The subscription states the database CHECK accepts, so a Stripe status outside this set is refused rather than written. */
const STRIPE_SUBSCRIPTION_STATUSES = ["incomplete", "trialing", "active", "past_due", "unpaid", "canceled"] as const;

type StripeSubscriptionStatus = (typeof STRIPE_SUBSCRIPTION_STATUSES)[number];

function isStripeSubscriptionStatus(value: unknown): value is StripeSubscriptionStatus {
  return typeof value === "string" && (STRIPE_SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

/**
 * Stripe sends period bounds as Unix seconds. Anything that is not a finite
 * number becomes null rather than a fabricated date — an absent period end is
 * recoverable, a wrong one is not.
 */
function toIsoOrNull(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return new Date(value * 1000).toISOString();
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();

  app.disable("x-powered-by");

  app.get(HEALTH_PATH, (_request, response) => {
    const body: HealthResponse = {
      status: "ok",
      service: APP_NAME,
    };

    response.status(200).json(body);
  });

  // R3.1: isModerator is included so the client can conditionally show
  // moderator-only navigation (e.g. the /moderator route) without a
  // separate round trip — the actual authorization boundary remains
  // server-side (requireModeratorOrAdmin on every moderation route below,
  // R8.1's admin-inclusive gate), this is a UX signal only, never trusted
  // as an authorization decision itself.
  const checkIsModerator = options.checkIsModerator ?? isModerator;
  // R5.4a: same "UX signal only, never the authorization boundary itself"
  // caveat isModerator already carries — any *verified* claim, not scoped
  // to one company (createRequireEmployerOf is the real per-company gate).
  const checkHasVerifiedEmployerClaim = options.checkHasVerifiedEmployerClaim ?? hasVerifiedEmployerClaim;
  // R8.1: same "UX signal only, never the authorization boundary itself"
  // caveat isModerator already carries — requireAdmin below is the real gate.
  const checkIsAdmin = options.checkIsAdmin ?? isAdmin;

  app.get(
    "/api/me",
    createRequireAuth(options.verifyAccessToken),
    async (request: AuthenticatedRequest, response) => {
      response.set("Cache-Control", "no-store");
      response.set("Vary", "Authorization");
      const userIsModerator = await checkIsModerator(request.user!.id);
      const userIsEmployer = await checkHasVerifiedEmployerClaim(request.user!.id);
      const userIsAdmin = await checkIsAdmin(request.user!.id);
      response.status(200).json({
        ...request.user,
        isModerator: userIsModerator,
        isEmployer: userIsEmployer,
        isAdmin: userIsAdmin,
      });
    },
  );

  // -------------------------------------------------------------------------
  // Stripe webhook — REGISTERED BEFORE express.json(), AND IT MUST STAY HERE.
  //
  // Stripe signs the exact bytes it sent. express.json() consumes the request
  // stream and hands the route a parsed object; the original bytes are then
  // unrecoverable, so a signature check running after it can never succeed and
  // would have to be weakened to "trust the parsed body" — which for this
  // endpoint means trusting anyone who can POST to it to grant themselves a paid
  // plan. Registering with express.raw() ahead of the JSON parser is the only
  // ordering that keeps both the parsed body everywhere else and the raw bytes
  // here.
  //
  // Unauthenticated by design: the signature IS the authentication, which is why
  // an unconfigured or absent webhook secret answers 503 rather than skipping
  // verification.
  // -------------------------------------------------------------------------
  app.post(
    "/api/billing/webhook",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (request, response) => {
      const config = readStripeConfig();

      if (!config || !config.webhookSecret) {
        response.status(503).json({ error: "Billing webhook is not configured." });
        return;
      }

      const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const payload = raw.toString("utf8");

      if (!verifyStripeSignature(payload, request.header("stripe-signature"), config.webhookSecret)) {
        response.status(400).json({ error: "Invalid signature." });
        return;
      }

      let event: { type?: unknown; data?: { object?: Record<string, unknown> } };
      try {
        event = JSON.parse(payload) as typeof event;
      } catch {
        response.status(400).json({ error: "Malformed event body." });
        return;
      }

      const object = event.data?.object ?? {};

      try {
        const client = options.serviceClient ?? createSupabaseServiceRoleClient();

        if (event.type === "checkout.session.completed") {
          const metadata = (object.metadata ?? {}) as Record<string, unknown>;
          const candidateId = typeof metadata.candidate_id === "string" ? metadata.candidate_id : null;
          const planCode = typeof metadata.plan_code === "string" ? metadata.plan_code : null;
          const region = typeof metadata.region === "string" ? metadata.region : null;
          const currency = typeof metadata.currency === "string" ? metadata.currency : null;
          const interval = metadata.billing_interval;

          if (!candidateId || !planCode || !region || !currency || !isBillingInterval(interval)) {
            // Configured-out metadata is a bug on OUR side, not a forged event —
            // the signature already passed. Reported loudly and not recorded.
            console.error("[billing:webhook] checkout session missing metadata", {
              hasCandidate: candidateId !== null,
              hasPlan: planCode !== null,
              hasRegion: region !== null,
              hasCurrency: currency !== null,
              interval: String(interval),
            });
            response.status(200).json({ received: true, applied: false });
            return;
          }

          const result = await applyCheckoutCompleted(client, {
            candidateId,
            planCode,
            provider: "stripe",
            providerCustomerId: typeof object.customer === "string" ? object.customer : null,
            providerSubscriptionId: typeof object.subscription === "string" ? object.subscription : null,
            region,
            currency,
            billingInterval: interval,
            // Stripe sends the billing period on the subscription object, not on
            // the session, so the period end is genuinely unknown at this point.
            // Recorded as null rather than guessed from the plan interval.
            currentPeriodStart: new Date().toISOString(),
            currentPeriodEnd: null,
          });

          if (result.kind === "unknown_plan") {
            console.error("[billing:webhook] checkout session named an unknown plan", { planCode: result.planCode });
          }

          response.status(200).json({ received: true, applied: result.kind === "applied" });
          return;
        }

        if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
          const providerSubscriptionId = typeof object.id === "string" ? object.id : null;
          const status = event.type === "customer.subscription.deleted" ? "canceled" : object.status;

          if (!providerSubscriptionId || !isStripeSubscriptionStatus(status)) {
            response.status(200).json({ received: true, applied: false });
            return;
          }

          const result = await applyProviderSubscriptionUpdate(client, {
            providerSubscriptionId,
            status,
            currentPeriodStart: toIsoOrNull(object.current_period_start),
            currentPeriodEnd: toIsoOrNull(object.current_period_end),
            cancelAtPeriodEnd: object.cancel_at_period_end === true,
          });

          response.status(200).json({ received: true, applied: result.kind === "updated" });
          return;
        }

        // Every other event type is acknowledged and ignored. Stripe retries on
        // any non-2xx, so answering 400 for an event the product does not handle
        // would produce a retry storm for correct behaviour.
        response.status(200).json({ received: true, applied: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[billing:webhook] handler failed", { error: message });
        // 500 so Stripe retries: this is our failure, not a bad event.
        response.status(500).json({ error: "Failed to apply webhook event." });
      }
    },
  );

  // -------------------------------------------------------------------------
  // Razorpay webhook — SAME ORDERING CONSTRAINT AS THE STRIPE WEBHOOK ABOVE,
  // AND FOR THE SAME REASON. Razorpay signs the raw bytes, so this must be
  // registered with express.raw() before express.json() consumes the stream;
  // after that the original bytes are gone and no signature can be checked.
  //
  // Unauthenticated by design: the signature IS the authentication, which is why
  // an unconfigured webhook secret answers 503 rather than skipping the check.
  //
  // The handler resolves the candidate and plan from the ORDER'S OWN NOTES,
  // which Razorpay copies onto the payment. Reconstructing them from the amount
  // would mean inferring which of several same-priced plans was bought.
  // -------------------------------------------------------------------------
  app.post(
    "/api/billing/razorpay/webhook",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (request, response) => {
      const config = readRazorpayConfig();

      if (!config || !config.webhookSecret) {
        response.status(503).json({ error: "Razorpay webhook is not configured." });
        return;
      }

      const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const payload = raw.toString("utf8");

      if (
        !verifyRazorpayWebhookSignature(payload, request.header("x-razorpay-signature"), config.webhookSecret)
      ) {
        response.status(400).json({ error: "Invalid signature." });
        return;
      }

      let event: { event?: unknown; payload?: { payment?: { entity?: Record<string, unknown> } } };

      try {
        event = JSON.parse(payload) as typeof event;
      } catch {
        response.status(400).json({ error: "Malformed event body." });
        return;
      }

      // Razorpay's useful fields sit two levels down on the payment entity.
      const payment = event.payload?.payment?.entity ?? {};
      const notes = (payment.notes ?? {}) as Record<string, unknown>;

      try {
        if (event.event === "payment.captured" || event.event === "order.paid") {
          const candidateId = typeof notes.candidate_id === "string" ? notes.candidate_id : null;
          const planCode = typeof notes.plan_code === "string" ? notes.plan_code : null;
          const region = typeof notes.region === "string" ? notes.region : null;
          const currency = typeof notes.currency === "string" ? notes.currency : null;
          const interval = notes.billing_interval === "year" ? "year" : "month";

          if (!candidateId || !planCode || !region || !currency) {
            // The order is ours, so a missing note is our gap rather than a
            // hostile event. Acknowledged (200) so Razorpay stops retrying
            // something this handler cannot ever apply.
            console.error("[billing:razorpay-webhook] event carried no usable notes", { event: event.event });
            response.status(200).json({ received: true, applied: false });
            return;
          }

          const applied = await applyCheckoutCompleted(
            options.serviceClient ?? createSupabaseServiceRoleClient(),
            {
              candidateId,
              planCode,
              provider: "razorpay",
              providerCustomerId: typeof payment.customer_id === "string" ? payment.customer_id : null,
              providerSubscriptionId: typeof payment.id === "string" ? payment.id : null,
              region,
              currency,
              billingInterval: interval,
              currentPeriodStart: new Date().toISOString(),
              // No period end: Razorpay subscriptions are not modelled here yet,
              // and a NULL end is the honest "unknown" rather than an invented
              // renewal date that the cancellation path would then honour.
              currentPeriodEnd: null,
            },
          );

          response.status(200).json({ received: true, applied: applied.kind === "applied" });
          return;
        }

        // Every other event is acknowledged and ignored. Razorpay retries on any
        // non-2xx, so answering 400 for an event the product does not handle
        // would produce a retry storm for correct behaviour.
        response.status(200).json({ received: true, applied: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[billing:razorpay-webhook] handler failed", { error: message });
        // 500 so Razorpay retries: this is our failure, not a bad event.
        response.status(500).json({ error: "Failed to apply webhook event." });
      }
    },
  );

  app.use(express.json());

  const requireAuth = createRequireAuth(options.verifyAccessToken);
  const requireAdmin = createRequireAdmin(checkIsAdmin);
  // R8.1: every existing /api/moderation/* route below is regated to this
  // instead of requireModerator directly, so admins reach them too without
  // duplicating the route family under /api/admin/*.
  const requireModeratorOrAdmin = createRequireModeratorOrAdmin(checkIsModerator, checkIsAdmin);
  // R5.4b: requireEmployerOf's first real consumer — companyId comes from
  // the route param, same shape as requireModerator's global check but
  // scoped per-company.
  const requireEmployerOfCompanyParam = createRequireEmployerOf(
    (request) => request.params.companyId as string | undefined,
    options.checkIsVerifiedEmployer ?? isVerifiedEmployerOf,
  );
  // R5.4c: /api/employer/appeals has no companyId in its URL (the vacancy
  // implies it) — the client sends companyId in the body instead, gated
  // here the same way, then cross-checked again inside submitVacancyAppeal
  // against the vacancy's own company_id before anything is written.
  const requireEmployerOfCompanyBody = createRequireEmployerOf(
    (request) => (request.body as { companyId?: string } | undefined)?.companyId,
    options.checkIsVerifiedEmployer ?? isVerifiedEmployerOf,
  );
  const requireWorkerSecret = createRequireWorkerSecret(options.workerSecret ?? process.env.WORKER_TRIGGER_SECRET);
  const resolveServiceClient = () => options.serviceClient ?? createSupabaseServiceRoleClient();
  const resolveOpenAIClient = () => options.openaiClient ?? createOpenAIClient();
  const resolveGoogleOAuthConfig = () => options.googleOAuthConfig ?? readGoogleOAuthConfig();
  const resolveMailboxEncryptionKey = () => options.mailboxEncryptionKey ?? readMailboxEncryptionKey();
  const resolveMailboxOAuthStateSecret = () => {
    const secret = options.mailboxOAuthStateSecret ?? process.env.MAILBOX_OAUTH_STATE_SECRET;
    if (!secret) {
      throw new Error("Missing MAILBOX_OAUTH_STATE_SECRET.");
    }
    return secret;
  };
  const mailboxClientAppUrl = options.mailboxClientAppUrl ?? process.env.CLIENT_APP_URL ?? "";

  // Extraction calls a paid external API per request — rate-limited per
  // authenticated candidate (not per IP), so this only ever runs after
  // requireAuth has set request.user.
  const extractFactsRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (request: AuthenticatedRequest) => request.user!.id,
    message: { error: "Too many extraction requests. Please try again later." },
  });

  // Interview Preparation Phase 1. Candidate-triggered and cost-bearing (one
  // OpenRouter call each), so it is bounded per candidate rather than left open
  // to a signed-in user holding the button down. Deliberately looser than the
  // extraction limit above: a candidate reasonably regenerates prep for several
  // different vacancies in one sitting, whereas a resume is extracted once.
  const interviewPrepRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (request: AuthenticatedRequest) => request.user!.id,
    message: { error: "Too many interview preparation requests. Please try again later." },
  });

  // AI Career Copilot. Chat is the most repeatable model call in the product — a
  // candidate types a follow-up every few seconds — and the whole transcript is
  // re-sent on every turn, so the cost of a request grows with its own
  // conversation. Bounded per candidate on the same 15-minute window the two
  // limits above use, keyed on the verified session requireAuth has set.
  const agentChatRateLimit = rateLimit({
    windowMs: AGENT_RATE_LIMIT_WINDOW_MS,
    limit: AGENT_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (request: AuthenticatedRequest) => request.user!.id,
    message: { error: "Too many Copilot messages. Please try again later." },
  });

  // R4 action execution. This one WRITES, so it is bounded more tightly than
  // chat and keyed on the candidate: approving an action is a deliberate act,
  // not something anyone does in a loop.
  const agentActionRateLimit = rateLimit({
    windowMs: AGENT_ACTION_RATE_LIMIT_WINDOW_MS,
    limit: AGENT_ACTION_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (request: AuthenticatedRequest) => request.user!.id,
    message: { error: "Too many Copilot actions. Please try again later." },
  });

  // Admin-triggered worker batches. These spend third-party quota and model
  // spend per click (Jooble's free plan is a 500-request LIFETIME budget), so
  // the ceiling is per admin rather than per IP: an office sharing one address
  // should not share one operator's budget, and one operator should not be able
  // to drain a queue in a loop. Keyed on the verified session, which requireAuth
  // has already set by the time this runs.
  const adminWorkerRunRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (request: AuthenticatedRequest) => request.user!.id,
    message: { error: "Too many worker triggers. Please try again later." },
  });

  // Candidate-facing "Fetch latest jobs" trigger for the Opportunities page.
  // Unlike the /api/worker/* routes below (external-scheduler driven, worker
  // secret), this one is deliberately reachable by any signed-in candidate —
  // that is the feature. The quota danger that creates is handled inside
  // runIngestionBatch's per-target cooldown; this limiter only bounds request
  // volume so one candidate cannot spin the endpoint.
  const ingestionRefreshRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 6,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (request: AuthenticatedRequest) => request.user!.id,
    message: { error: "Too many refresh requests. Please try again later." },
  });

  app.post(
    "/api/opportunities/refresh",
    requireAuth,
    ingestionRefreshRateLimit,
    async (_request: AuthenticatedRequest, response) => {
      try {
        const result = await runIngestionBatch(resolveServiceClient());
        response.set("Cache-Control", "no-store");
        response.status(200).json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Opportunity refresh failed:", message);
        response.status(500).json({ error: "Failed to refresh opportunities" });
      }
    },
  );

  /**
   * The MANUAL preference-ranking refresh, driven by the feed and the target-roles
   * page — never by a cron. Each call runs BOUNDED work to a wall-clock deadline
   * and persists progress; the client polls until the workflow settles.
   *
   * IDENTITY COMES ONLY FROM THE VERIFIED SESSION. request.user.id is the JWT
   * subject, which equals candidate_profiles.id; a body-supplied candidate id is
   * never read, so one candidate cannot make the server do work for another.
   *
   * IT REQUIRES NOTHING BUT A SESSION. Manual browsing and matching need no
   * automation consent, no paid plan and no parsed resume — this route calls only
   * the tokenizer/indexer/materialiser, never a model or a provider, and never
   * submits anything. It shares the ingestion limiter because both are
   * candidate-triggered background work and one budget is easier to reason about.
   */
  app.post(
    "/api/opportunities/ranking-refresh",
    requireAuth,
    ingestionRefreshRateLimit,
    async (request: AuthenticatedRequest, response) => {
      const body = (request.body ?? {}) as Record<string, unknown>;

      try {
        const result = await runRankingRefresh(resolveServiceClient(), request.user!.id, {
          force: body.force === true,
        });
        response.set("Cache-Control", "no-store");
        response.status(200).json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Ranking refresh failed:", message);
        response.status(500).json({ error: "Failed to refresh preference ranking" });
      }
    },
  );

  // Task A1: the "Fetch latest jobs" button's real backend.
  //
  // WHY THIS EXISTS SEPARATELY FROM /api/opportunities/refresh. That route
  // drains the ingestion_jobs QUEUE, and nothing in this repository enqueues
  // jobs — there is no scheduler ("no deployment/scheduling infrastructure
  // exists yet in this repo", per runner.ts). So the button span the spinner,
  // ran a batch over an empty queue, and changed nothing, every single time.
  // This route runs discovery ON DEMAND instead, through the same runIntake
  // the discover_live_jobs MCP tool calls, so the button and the agent use one
  // implementation.
  //
  // Shares the refresh rate limiter rather than getting its own: both are
  // "go and hit a third party for me" actions, and a candidate should have one
  // budget for that rather than two.
  app.post("/api/intake/discover", requireAuth, ingestionRefreshRateLimit, async (request: AuthenticatedRequest, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const requestedSource = typeof body.sourceCode === "string" ? body.sourceCode.trim() : "";
    const search = typeof body.search === "string" && body.search.trim() ? body.search.trim() : undefined;
    const limit = typeof body.limit === "number" ? body.limit : undefined;

    const registered = listIntakeAdapters();

    if (registered.length === 0) {
      response.status(503).json({ error: "No intake sources are configured on this server." });
      return;
    }

    // NO DEFAULTING, NO SINGLE-SOURCE ASSUMPTION. This route previously
    // defaulted to the one registered adapter and 400'd ("Unknown intake
    // source") the moment a second was registered, because the client sends no
    // body to name one — so the button worked only for as long as exactly one
    // source existed. An explicit sourceCode is still honoured, and a typo in it
    // is still a 400 (silently fanning out over everything would answer a
    // different question than the one asked), but omitting it now means "every
    // registered source", which is what the button actually wants.
    if (requestedSource && !registered.some((adapter) => adapter.sourceCode === requestedSource)) {
      response.status(400).json({
        error: `Unknown intake source. Registered: ${registered.map((a) => a.sourceCode).join(", ")}.`,
      });
      return;
    }

    try {
      const client = resolveServiceClient();

      // The candidate's own search context, read with the service-role client
      // and scoped to the verified token's user id. It is what lets the
      // credentialed aggregators be asked anything at all: Jooble needs
      // keywords and a location, Adzuna needs an ISO country. Remotive ignores
      // all three, so a candidate with an empty profile still gets results from
      // it — and the sources that cannot run are reported as skips with reasons
      // rather than silently contributing nothing.
      const queryContext = await loadIntakeQueryContext(client, request.user!.id);

      // Fan-out. Each source is isolated inside runIntakeAcrossSources, so one
      // missing a source_policies row or being down cannot cost the candidate
      // the sources that work.
      const result = await runIntakeAcrossSources(
        client,
        {
          sourceCodes: requestedSource ? [requestedSource] : undefined,
          search,
          limit,
          keywords: queryContext.keywords,
          location: queryContext.location,
          country: queryContext.country,
        },
        {},
      );
      const newVacancyIds = result.newVacancyIds;

      // Task A2: score the new vacancies NOW, targeted at their own ids.
      //
      // Without this they carry a NULL priority_score and sort below every
      // scored row, so "fetch latest jobs" produced jobs the candidate could
      // not find. Draining the ordinary queue would not have fixed it either:
      // that claim is FIFO, so a batch of any size would have worked through
      // the existing backlog and never reached these.
      //
      // Best-effort by design. A scoring failure must not fail the fetch — the
      // vacancies are already ingested and visible, and the fit queue will pick
      // them up on the next scheduled drain. Same "AI step isolated from
      // ingestion" stance the ingestion worker takes towards scoreVacancy.
      let fit: { analyzed: number; failed: number; stoppedOnDeadline: boolean; error?: string } | null = null;

      if (newVacancyIds.length > 0) {
        try {
          const fitResult = await runFitAnalysisBatch(
            client,
            { openai: resolveOpenAIClient() },
            {
              vacancyIds: newVacancyIds,
              maxPerBatch: MAX_FIT_ANALYSES_PER_DISCOVERY,
              deadlineMs: FIT_ANALYSIS_BUDGET_MS,
            },
          );

          fit = {
            analyzed: fitResult.analyzed,
            failed: fitResult.failed,
            stoppedOnDeadline: fitResult.stoppedOnDeadline === true,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("Post-discovery fit analysis failed:", message);
          fit = { analyzed: 0, failed: 0, stoppedOnDeadline: false, error: message };
        }
      }

      // Structured, one line per discovery.
      //
      // This route previously logged NOTHING on success, which is exactly why
      // "I clicked Fetch latest jobs and nothing happened" could not be
      // diagnosed from the server side: a run that legitimately created zero
      // vacancies left no trace at all, so "the intake ran and found nothing
      // new" and "the request never arrived" looked identical in the logs.
      console.log(
        `[intake:discover] candidate=${request.user!.id} sources=${result.sources.length} ` +
          `failed=${result.failedSources} received=${result.received} ingested=${result.ingested} ` +
          `created=${result.created} updated=${result.updated} ` +
          `fitAnalyzed=${fit?.analyzed ?? 0} fitFailed=${fit?.failed ?? 0} durationMs=${result.durationMs} ` +
          `perSource=${result.sources
            .map((source) =>
              source.status === "failed" ? `${source.sourceCode}:failed(${source.error})` : `${source.sourceCode}:+${source.created}`,
            )
            .join(",")}`,
      );

      response.set("Cache-Control", "no-store");
      response.status(200).json({
        // AGGREGATE TOTALS AT THE TOP LEVEL, per-source detail in `sources`.
        // The per-source entries are not optional decoration: `attribution` is a
        // per-source legal obligation (Remotive's terms require their name to
        // travel with their data), so collapsing several sources into one scalar
        // attribution would silently drop it. A failed source keeps its entry too
        // — otherwise "3 sources, 2 misconfigured" is indistinguishable from
        // "1 source, working fine".
        received: result.received,
        ingested: result.ingested,
        created: result.created,
        updated: result.updated,
        // The client marks these rows as new; without the ids it can only say
        // "something changed" while the list looks identical.
        newVacancyIds,
        /**
         * How many of those were scored before this response, and whether the
         * budget ran out first. The client uses this to decide what still needs
         * hoisting: a scored vacancy ranks on its own, an unscored one would
         * otherwise be invisible.
         */
        fitAnalyzed: fit?.analyzed ?? 0,
        fitPending: Math.max((fit === null ? 0 : newVacancyIds.length - fit.analyzed), 0),
        fitStoppedOnDeadline: fit?.stoppedOnDeadline ?? false,
        fitError: fit?.error ?? null,
        skippedByAdapter: result.skippedByAdapter,
        trustStatusCounts: result.trustStatusCounts,
        durationMs: result.durationMs,
        failedSources: result.failedSources,
        sources: result.sources,
      });
    } catch (error) {
      // Defensive: runIntakeAcrossSources converts a per-source failure into a
      // `status: "failed"` entry rather than throwing, so this now only catches
      // something that went wrong outside any single source.
      if (error instanceof IntakePolicyError) {
        // 409, not 500: the request is fine, the source is switched off.
        console.warn(`[intake:discover] refused by source policy: ${error.message}`);
        response.status(409).json({ error: error.message });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      console.error("Live discovery failed:", message);
      response.status(500).json({ error: "Could not fetch new jobs. Please try again." });
    }
  });

  // Bulk enqueue for the Opportunities page. Deliberately NOT a second
  // rate-limit implementation of the product's abuse cap: the 25/24h
  // MAX_DAILY_APPLICATIONS_PER_CANDIDATE rule is enforced by
  // planApplication's rate_and_abuse_controls gate, which this route reaches
  // through the same funnel as every other enqueue path. This limiter bounds
  // request VOLUME only — each call fans out to several queries per vacancy,
  // the same reason /api/resumes/:id/extract and /api/opportunities/refresh
  // carry one.
  const bulkApplyRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (request: AuthenticatedRequest) => request.user!.id,
    message: { error: "Too many bulk apply requests. Please try again later." },
  });

  // ---------------------------------------------------------------------------
  // GET /api/opportunities/capability
  //
  // WHETHER AUTOMATIC APPLICATION CAN RUN AT ALL, for the Opportunities page and
  // the Home automation card. Both used to imply it could: the bulk button said
  // "Apply to N loaded matches" and the automation badge said "Active", while no
  // source can carry an application. A candidate cannot discover this on their
  // own — source_policies is internal governance data with no grants to
  // authenticated (20260813205320_source_policies.sql) — so it has to be served.
  //
  // A BOOLEAN AND ONE SENTENCE, NOT THE DATA BEHIND IT. The source codes, the
  // policy flags and the adapter registry are operator concerns; a candidate
  // needs to know whether the action is available and, if not, why in plain
  // language. Returning the list would leak the commercial/legal posture of each
  // source to any signed-in account and would invite the client to re-derive a
  // decision the server already owns.
  //
  // NOT CACHED, because a policy or adapter can change between requests and a
  // cached "yes" would re-enable a button that no longer works.
  // ---------------------------------------------------------------------------
  app.get("/api/opportunities/capability", requireAuth, async (_request, response) => {
    try {
      const capability = await loadQueueCapability(resolveServiceClient());

      response.set("Cache-Control", "no-store");
      response.status(200).json({
        canQueue: capability.canQueue,
        explanation: capability.canQueue
          ? "Automatic applications are available."
          : "Automatic submission unavailable — no available job source supports it yet.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Queue capability read failed:", message);
      // 500 rather than a "false": the client must be able to tell "sources are
      // unavailable" from "we could not check", and a false would collapse the
      // two into the same misleading claim.
      response.status(500).json({ error: "Could not check application availability" });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/readiness
  //
  // THE STRUCTURED SETUP STATE the Home checklist renders, from the same
  // loadCandidateReadiness call the bulk-apply route already refuses on. Exposed
  // so the checklist renders the one shared rule instead of re-deriving it in
  // the browser (which is how the UI and the gate drift apart). Read-only and
  // scoped to the authenticated candidate. The FULL Readiness object is returned
  // so a future banner or nav indicator can reuse it without another round-trip.
  //
  // NOT CACHED: the steps and the plan/source flags change as the candidate acts,
  // and a cached "incomplete" would keep a finished checklist on screen.
  // ---------------------------------------------------------------------------
  app.get("/api/readiness", requireAuth, async (request: AuthenticatedRequest, response) => {
    try {
      const readiness = await loadCandidateReadiness(resolveServiceClient(), request.user!.id);

      response.set("Cache-Control", "no-store");
      response.status(200).json(readiness);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Readiness read failed:", message);
      // 500, not a fabricated "not set up": the checklist must be able to tell
      // "not set up" from "we could not check", and a default would either hide a
      // refusal or claim readiness the server never verified.
      response.status(500).json({ error: "Could not check your setup progress" });
    }
  });

  app.post(
    "/api/opportunities/bulk-apply",
    requireAuth,
    bulkApplyRateLimit,
    async (request: AuthenticatedRequest, response) => {
      const { vacancyIds } = (request.body ?? {}) as { vacancyIds?: unknown };

      if (!Array.isArray(vacancyIds) || vacancyIds.length === 0) {
        response.status(400).json({ error: "vacancyIds must be a non-empty array." });
        return;
      }

      if (vacancyIds.length > MAX_BULK_APPLY_VACANCIES) {
        response.status(400).json({
          error: `vacancyIds must contain at most ${MAX_BULK_APPLY_VACANCIES} entries.`,
        });
        return;
      }

      if (!vacancyIds.every((id) => typeof id === "string" && UUID_PATTERN.test(id))) {
        response.status(400).json({ error: "Every vacancyId must be a valid id." });
        return;
      }

      try {
        // SETUP READINESS, ENFORCED SERVER-SIDE. The Home card hides the action
        // when setup is incomplete, but a hidden button is not a gate: this
        // endpoint can be called directly, so the same rule is re-derived here
        // from authoritative rows. Refusing before any planning happens means an
        // unset-up account cannot create application plans at all.
        //
        // THIS ADDS TO THE EXISTING GATES AND REMOVES NONE. The eligibility,
        // source-policy, adapter, duplicate and consent checks still run inside
        // bulkApplyToVacancies for every vacancy that gets this far.
        const readiness = await loadCandidateReadiness(resolveServiceClient(), request.user!.id);
        const refusals = setupRefusals(readiness);

        if (refusals.length > 0) {
          response.set("Cache-Control", "no-store");
          // 409 rather than 400: the request is well-formed, the account's state
          // is what refuses it. The structured blockers let a client say which
          // step is missing instead of showing one generic sentence.
          response.status(409).json({
            error: "Finish setting up your account before queueing applications.",
            blockers: refusals,
          });
          return;
        }

        const result = await bulkApplyToVacancies(resolveServiceClient(), {
          candidateId: request.user!.id,
          vacancyIds: vacancyIds as string[],
        });

        response.set("Cache-Control", "no-store");
        response.status(200).json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Bulk apply failed:", message);
        response.status(500).json({ error: "Failed to queue applications" });
      }
    },
  );

  app.post("/api/vacancies/:vacancyId/reports", requireAuth, async (request: AuthenticatedRequest, response) => {
    const { category, description } = request.body ?? {};

    if (!REPORT_CATEGORIES.includes(category)) {
      response.status(400).json({ error: `category must be one of: ${REPORT_CATEGORIES.join(", ")}` });
      return;
    }

    try {
      const result = await submitVacancyReport(resolveServiceClient(), {
        vacancyId: request.params.vacancyId as string,
        reporterId: request.user!.id,
        category: category as ReportCategory,
        description: typeof description === "string" ? description : undefined,
      });
      response.status(201).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: message });
    }
  });

  app.post(
    "/api/resumes/:id/extract",
    requireAuth,
    extractFactsRateLimit,
    async (request: AuthenticatedRequest, response) => {
      if (!UUID_PATTERN.test(request.params.id as string)) {
        response.status(400).json({ error: "id must be a valid resume id." });
        return;
      }

      try {
        const result = await extractResumeFacts(resolveServiceClient(), resolveOpenAIClient(), {
          resumeId: request.params.id as string,
          candidateId: request.user!.id,
        });

        switch (result.kind) {
          case "success":
            response.status(201).json({ facts: result.facts });
            return;
          case "not_found":
            response.status(404).json({ error: "Resume not found." });
            return;
          case "unsupported_format":
            response.status(422).json({ error: "This resume's file format isn't supported for extraction." });
            return;
          case "malformed_extraction":
            response.status(422).json({ error: result.message });
            return;
          case "error":
            response.status(500).json({ error: result.message });
            return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Interview Preparation Phase 1.
  //
  // POST /api/vacancies/:vacancyId/interview-prep
  //
  // Takes only a vacancy id — the JD comes from the vacancy's own snapshot and
  // the candidate context comes from the caller's CONFIRMED facts, resolved
  // server-side from the verified token's user id. Nothing about the candidate's
  // qualifications is accepted from the request body, so a client cannot feed
  // the model fabricated experience.
  //
  // 422 (not 404) when the vacancy exists but has no JD snapshot: the vacancy is
  // real and the candidate may legitimately be looking at it, so the honest
  // answer is "there is nothing to generate from", not "not found". This mirrors
  // analyzeFit, which skips the AI call entirely when jd_text_available is false.
  //
  // No persistence: the generated prep is returned and forgotten. Nothing is
  // written, so there is no new table, RLS policy, or stored copy of the
  // candidate's interview answers.
  // ---------------------------------------------------------------------------
  app.post(
    "/api/vacancies/:vacancyId/interview-prep",
    requireAuth,
    interviewPrepRateLimit,
    async (request: AuthenticatedRequest, response) => {
      const vacancyId = request.params.vacancyId as string;

      if (!UUID_PATTERN.test(vacancyId)) {
        response.status(400).json({ error: "vacancyId must be a valid vacancy id." });
        return;
      }

      try {
        const result = await prepareInterviewPrep(resolveServiceClient(), resolveOpenAIClient(), {
          vacancyId,
          candidateId: request.user!.id,
        });

        switch (result.kind) {
          case "success":
            // Generated per request and not cached; no-store keeps a shared
            // proxy from holding one candidate's prep.
            response.set("Cache-Control", "no-store");
            response.status(200).json(result.prep);
            return;
          case "vacancy_not_found":
            response.status(404).json({ error: "Vacancy not found." });
            return;
          case "vacancy_not_eligible":
            // 422 rather than 404: the candidate may well be looking at this
            // row already (the Opportunities view surfaces UNDER_REVIEW jobs),
            // so its existence is not a secret and a clear refusal beats a
            // misleading "not found". The message deliberately does not name
            // the internal trust status — that vocabulary is not the
            // candidate's to interpret here.
            response.status(422).json({
              error: "Interview preparation is only available for verified vacancies.",
            });
            return;
          case "no_jd_text":
            response.status(422).json({
              error: "This vacancy has no job description text, so interview questions cannot be generated from it.",
            });
            return;
          case "malformed_prep":
            response.status(422).json({ error: result.message });
            return;
          case "error":
            response.status(500).json({ error: result.message });
            return;
        }
      } catch (error) {
        // resolveServiceClient / resolveOpenAIClient throw when their env is
        // unset — a 500 with the real reason beats a silent misconfiguration.
        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // AI Career Copilot.
  //
  // POST /api/agent/chat
  //
  // THE CONVERSATION IS CLIENT-HELD. The drawer sends the transcript it has and
  // the server answers its last turn; nothing is written, so there is no table,
  // no migration, and no stored copy of what a candidate asked. Same
  // no-persistence stance as the interview-prep route above.
  //
  // THE CANDIDATE'S CONTEXT IS RESOLVED SERVER-SIDE from the verified token's
  // user id, never from the body. A client therefore cannot describe the
  // candidate to the model, so it cannot feed it experience the candidate does
  // not have — the only thing the request controls is the question.
  //
  // The model is a body field, so it is checked against the shared whitelist
  // rather than passed through: without that, any signed-in candidate could name
  // an arbitrary OpenRouter model and spend it against this deployment's key.
  // ---------------------------------------------------------------------------
  app.post(
    "/api/agent/chat",
    requireAuth,
    agentChatRateLimit,
    async (request: AuthenticatedRequest, response) => {
      const parsed = parseAgentChatRequest(request.body ?? {});

      if (!parsed.ok) {
        response.status(400).json({ error: parsed.message });
        return;
      }

      try {
        const result = await answerAgentChat(resolveServiceClient(), resolveOpenAIClient(), {
          candidateId: request.user!.id,
          messages: parsed.messages,
          model: parsed.model,
        });

        switch (result.kind) {
          case "success":
            // Generated per request and never cached; no-store keeps a shared
            // proxy from holding one candidate's answer.
            response.set("Cache-Control", "no-store");
            response.status(200).json({
              message: result.message,
              model: result.model,
              // INERT. Nothing here has run: each entry is a suggestion the
              // drawer renders as a card with an Approve button and nothing else.
              proposals: result.proposals,
            });
            return;
          case "empty_reply":
            // 502 rather than 500: the request was well-formed and this server
            // was up, so the failure is upstream and a retry is worth offering.
            response.status(502).json({ error: result.message });
            return;
          case "error":
            response.status(500).json({ error: result.message });
            return;
        }
      } catch (error) {
        // resolveServiceClient / resolveOpenAIClient throw when their env is
        // unset — a 500 with the real reason beats a silent misconfiguration.
        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // R4 — executing an action a candidate has APPROVED.
  //
  // POST /api/agent/actions/execute
  //
  // A SEPARATE ROUTE FROM CHAT, ON PURPOSE. Chat is read-only and cheap to
  // retry; this writes, so it carries its own tighter limit and its own audit
  // entry, and nothing in a model's reply can reach it. A proposal existing is
  // not sufficient to act: only this route acts, and only on a request that
  // arrives from a human's click.
  //
  // THE BODY IS A HUMAN'S APPROVAL AND IS STILL NOT TRUSTED. The tool name is
  // re-checked against the shared whitelist and the arguments are re-parsed by
  // the tool itself; the candidate id comes from the verified token, never the
  // body. A tampered approval can therefore only request an action the candidate
  // could already have taken from the Opportunities page.
  // ---------------------------------------------------------------------------
  app.post(
    "/api/agent/actions/execute",
    requireAuth,
    agentActionRateLimit,
    async (request: AuthenticatedRequest, response) => {
      const parsed = parseAgentActionRequest(request.body ?? {});

      if (!parsed.ok) {
        response.status(400).json({ error: parsed.message });
        return;
      }

      try {
        const result = await executeAgentAction(resolveServiceClient(), {
          candidateId: request.user!.id,
          tool: parsed.tool,
          args: parsed.args,
        });

        switch (result.kind) {
          case "executed":
            // Not cached: the result belongs to one candidate and reports a
            // state that has just changed.
            response.set("Cache-Control", "no-store");
            response.status(200).json({
              status: "executed",
              tool: result.tool,
              summary: result.summary,
              detail: result.detail,
            });
            return;
          case "blocked":
            // 200 ON PURPOSE. The action ran correctly and the gates refused
            // every job: that is a legitimate outcome for this request, not an
            // error, and a 4xx would tell the client to offer a retry that
            // cannot change the answer. The explicit status field is what stops
            // the drawer rendering it as a completed action.
            response.set("Cache-Control", "no-store");
            response.status(200).json({
              status: "blocked",
              tool: result.tool,
              summary: result.summary,
              detail: result.detail,
            });
            return;
          case "invalid_request":
          case "unknown_tool":
            response.status(400).json({ error: result.message });
            return;
          case "failed":
            response.status(500).json({ error: result.message });
            return;
        }
      } catch (error) {
        // resolveServiceClient throws when its env is unset — a 500 with the
        // real reason beats a silent misconfiguration.
        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Task V: the candidate-facing review workflow.
  //
  // These two are the candidate's own actions, authenticated by their Supabase
  // session (requireAuth) rather than by WORKER_TRIGGER_SECRET. Ownership is
  // checked on every call by loadOwnedAttempt, which follows
  // application_attempts -> application_plans.candidate_id and compares it to
  // the verified token's user id.
  //
  // BOTH ROUTES READ THE ATTEMPT WITH THE SERVICE-ROLE CLIENT, so RLS is not
  // doing the filtering for them — it has to be the explicit comparison. The
  // RLS policies on application_attempts do already stop a candidate reading
  // another candidate's rows (application_attempts_rls.test.sql asserts it),
  // but a service-role connection is not subject to them, which is precisely
  // why the check is written out rather than assumed.
  //
  // "Not yours" is answered with 404, never 403: a 403 would confirm that the
  // id names a real attempt belonging to somebody else, turning this into an
  // oracle for probing ids.
  // ---------------------------------------------------------------------------
  app.post(
    "/api/candidate/attempts/:id/generate-preview",
    requireAuth,
    async (request: AuthenticatedRequest, response) => {
      const attemptId = request.params.id as string;

      if (!UUID_PATTERN.test(attemptId)) {
        response.status(400).json({ error: "id must be a valid application attempt id." });
        return;
      }

      try {
        const preview = await generateAttemptPreview(
          resolveServiceClient(),
          { createOpenAIClient: resolveOpenAIClient },
          { candidateId: request.user!.id, applicationAttemptId: attemptId },
        );

        response.status(200).json({
          applicationAttemptId: preview.applicationAttemptId,
          status: preview.status,
          previewUrl: preview.previewUrl,
          previewUrlExpiresInSeconds: preview.previewUrlExpiresInSeconds,
          resumePrepared: preview.resumePrepared,
          resume: {
            documentId: preview.resume.documentId,
            originalFilename: preview.resume.originalFilename,
            tailored: preview.resume.tailored,
            optimizationLevel: preview.resume.optimizationLevel,
          },
          /**
           * The letter the candidate is about to approve, or the reason there
           * isn't one. Passed through in both cases: a preview that silently
           * omitted the letter would show someone less than they are approving,
           * which is the one thing this endpoint exists to prevent.
           *
           * The per-paragraph factRefs are deliberately NOT sent. They are the
           * audit record, stored on the row for later inspection — putting them
           * in the response would invite a client to render citation ids next
           * to prose the candidate is reading for its wording, not its ids.
           */
          coverLetter:
            preview.coverLetter.kind === "generated"
              ? {
                  status: "generated",
                  text: preview.coverLetter.text,
                  promptVersion: preview.coverLetter.promptVersion,
                  modelVersion: preview.coverLetter.modelVersion,
                  citedFactCount: preview.coverLetter.citedFactCount,
                  generatedAt: preview.coverLetter.generatedAt,
                }
              : { status: "failed", reason: preview.coverLetter.reason },
        });
      } catch (error) {
        if (error instanceof ApplicationAttemptNotFoundError || error instanceof AttemptNotOwnedError) {
          response.status(404).json({ error: "Application attempt not found." });
          return;
        }

        if (error instanceof AttemptNotAwaitingReviewError) {
          response.status(409).json({
            error: "This application is not awaiting your review.",
            status: error.status,
          });
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        console.error("Generate preview failed:", message);
        response.status(500).json({ error: "Could not prepare your resume preview." });
      }
    },
  );

  app.post("/api/candidate/attempts/:id/approve", requireAuth, async (request: AuthenticatedRequest, response) => {
    const attemptId = request.params.id as string;

    if (!UUID_PATTERN.test(attemptId)) {
      response.status(400).json({ error: "id must be a valid application attempt id." });
      return;
    }

    try {
      const result = await approveOwnedAttempt(resolveServiceClient(), {
        candidateId: request.user!.id,
        applicationAttemptId: attemptId,
      });

      response.status(200).json({
        applicationAttemptId: result.applicationAttemptId,
        status: result.status,
        reviewApprovedAt: result.reviewApprovedAt,
      });
    } catch (error) {
      if (error instanceof ApplicationAttemptNotFoundError || error instanceof AttemptNotOwnedError) {
        response.status(404).json({ error: "Application attempt not found." });
        return;
      }

      if (error instanceof AttemptNotPreviewedError) {
        response.status(409).json({
          error: "Generate the resume preview before approving this application.",
        });
        return;
      }

      if (error instanceof AttemptNotAwaitingReviewError) {
        response.status(409).json({
          error: "This application is not awaiting your review.",
          status: error.status,
        });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      console.error("Candidate approval failed:", message);
      response.status(500).json({ error: "Could not approve this application." });
    }
  });

  // ---------------------------------------------------------------------------
  // Task C2: the anti-ghosting review surface.
  //
  // Same shape as the attempt-review routes above: requireAuth, ownership
  // resolved explicitly because the reads run on the service-role client and
  // bypass the RLS policy that could otherwise scope them, and 404 rather than
  // 403 for "not yours" so the id space cannot be probed.
  // ---------------------------------------------------------------------------
  app.get("/api/candidate/follow-ups/pending", requireAuth, async (request: AuthenticatedRequest, response) => {
    try {
      const followUps = await listPendingFollowUps(resolveServiceClient(), request.user!.id);

      response.set("Cache-Control", "no-store");
      response.status(200).json({ followUps });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Listing follow-ups failed:", message);
      response.status(500).json({ error: "Could not load your follow-ups. Please try again." });
    }
  });

  app.post(
    "/api/candidate/follow-ups/:id/send",
    requireAuth,
    async (request: AuthenticatedRequest, response) => {
      const draftId = request.params.id as string;

      if (!UUID_PATTERN.test(draftId)) {
        response.status(400).json({ error: "id must be a valid follow-up draft id." });
        return;
      }

      try {
        const result = await sendFollowUpDraft(resolveServiceClient(), request.user!.id, draftId);

        response.status(200).json(result);
      } catch (error) {
        if (error instanceof FollowUpDraftNotFoundError || error instanceof FollowUpDraftNotOwnedError) {
          response.status(404).json({ error: "Follow-up draft not found." });
          return;
        }

        if (error instanceof FollowUpDraftNotPendingError) {
          response.status(409).json({
            error: "This follow-up is no longer awaiting your review.",
            status: error.status,
          });
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        console.error("Sending follow-up failed:", message);
        response.status(500).json({ error: "Could not send this follow-up. Please try again." });
      }
    },
  );

  app.post(
    "/api/candidate/follow-ups/:id/dismiss",
    requireAuth,
    async (request: AuthenticatedRequest, response) => {
      const draftId = request.params.id as string;

      if (!UUID_PATTERN.test(draftId)) {
        response.status(400).json({ error: "id must be a valid follow-up draft id." });
        return;
      }

      try {
        const result = await dismissFollowUpDraft(resolveServiceClient(), request.user!.id, draftId);

        response.status(200).json(result);
      } catch (error) {
        if (error instanceof FollowUpDraftNotFoundError || error instanceof FollowUpDraftNotOwnedError) {
          response.status(404).json({ error: "Follow-up draft not found." });
          return;
        }

        if (error instanceof FollowUpDraftNotPendingError) {
          response.status(409).json({
            error: "This follow-up is no longer awaiting your review.",
            status: error.status,
          });
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        console.error("Dismissing follow-up failed:", message);
        response.status(500).json({ error: "Could not dismiss this follow-up. Please try again." });
      }
    },
  );

  app.get("/api/moderation/queue", requireAuth, requireModeratorOrAdmin, async (_request, response) => {
    try {
      const queue = await getModerationQueue(resolveServiceClient());
      response.status(200).json(queue);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: message });
    }
  });

  app.post(
    "/api/moderation/cases/:caseId/decisions",
    requireAuth,
    requireModeratorOrAdmin,
    async (request: AuthenticatedRequest, response) => {
      const { decision, rationale, policyVersion, appealId } = request.body ?? {};

      if (!MODERATION_DECISIONS.includes(decision)) {
        response.status(400).json({ error: `decision must be one of: ${MODERATION_DECISIONS.join(", ")}` });
        return;
      }

      if (typeof rationale !== "string" || rationale.trim() === "") {
        response.status(400).json({ error: "rationale is required" });
        return;
      }

      if (typeof policyVersion !== "string" || policyVersion.trim() === "") {
        response.status(400).json({ error: "policyVersion is required" });
        return;
      }

      try {
        const client = resolveServiceClient();

        const result = await submitModerationDecision(client, {
          caseId: request.params.caseId as string,
          reviewerId: request.user!.id,
          decision: decision as ModerationDecisionValue,
          rationale,
          policyVersion,
          appealId: typeof appealId === "string" ? appealId : undefined,
        });

        // Task H4, PRD v3 §21.1/§29.3 ("Moderator decisions and appeals are
        // auditable"). Recorded AFTER the decision commits, deliberately: an
        // audit row for a decision that then failed to write would be a record
        // of something that never happened, which is worse than a gap.
        //
        // The rationale is carried across because it IS the justification, and an
        // audit trail of moderation without the reasons is a list of verdicts
        // nobody can review.
        await recordAuditEvent(client, {
          actorId: request.user!.id,
          actorRole: "moderator",
          action: "moderation.decision.recorded",
          entityType: "moderation_case",
          entityId: request.params.caseId as string,
          summary: "Recorded a moderation decision: " + String(decision),
          reason: rationale,
          newValues: {
            decision,
            policyVersion,
            appealId: typeof appealId === "string" ? appealId : null,
          },
        });

        response.status(201).json(result);
      } catch (error) {
        if (error instanceof ReviewerSeparationError) {
          response.status(409).json({ error: error.message });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      }
    },
  );

  // R6.1: starts the Gmail connect handshake — mints a signed `state` and
  // hands back the Google consent URL for the client to navigate to.
  app.post("/api/mailbox/connect/start", requireAuth, (request: AuthenticatedRequest, response) => {
    // Task H2: a deployment with no Google credentials is a configuration state,
    // not a server fault, and the two deserve different answers. 503 with the
    // reader's own reason tells the caller what to fix; the 500 this used to
    // return read as a bug in the server. The capability probe is what makes the
    // distinction possible without catching a message string.
    const capability = readMailboxCapability();
    if (!capability.googleMail.enabled) {
      response.status(503).json({
        error: "Mailbox connection is not configured on this deployment.",
        reason: capability.googleMail.reason,
      });
      return;
    }

    try {
      const { authorizeUrl } = startMailboxConnect(
        request.user!.id,
        resolveGoogleOAuthConfig(),
        resolveMailboxOAuthStateSecret(),
      );
      response.status(200).json({ authorizeUrl });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: message });
    }
  });

  // R6.1: Google redirects the browser here directly — a top-level
  // navigation, so it carries no Authorization header and can't go through
  // requireAuth. Identity is instead proven by the signed `state` param
  // (see oauthState.ts). Always ends in a redirect, success or failure —
  // there's no JSON client waiting on this response.
  app.get("/api/mailbox/oauth/callback", async (request, response) => {
    const redirectTo = (status: "connected" | "error") => `${mailboxClientAppUrl}/?mailbox=${status}#/responses`;

    const { code, state, error: oauthError } = request.query;

    if (typeof oauthError === "string" || typeof code !== "string" || typeof state !== "string") {
      response.redirect(redirectTo("error"));
      return;
    }

    try {
      await completeMailboxConnect(
        resolveServiceClient(),
        resolveGoogleOAuthConfig(),
        resolveMailboxOAuthStateSecret(),
        resolveMailboxEncryptionKey(),
        { code, state },
      );
      response.redirect(redirectTo("connected"));
    } catch (error) {
      if (!(error instanceof InvalidOAuthStateError)) {
        console.error("Mailbox OAuth callback failed:", error instanceof Error ? error.message : error);
      }
      response.redirect(redirectTo("error"));
    }
  });

  app.post(
    "/api/mailbox/:id/disconnect",
    requireAuth,
    async (request: AuthenticatedRequest, response) => {
      if (!UUID_PATTERN.test(request.params.id as string)) {
        response.status(400).json({ error: "id must be a valid mailbox connection id." });
        return;
      }

      try {
        const result = await disconnectMailboxConnection(
          resolveServiceClient(),
          { connectionId: request.params.id as string, candidateId: request.user!.id },
          resolveMailboxEncryptionKey(),
        );
        response.status(200).json(result);
      } catch (error) {
        if (error instanceof MailboxConnectionNotFoundError) {
          response.status(404).json({ error: error.message });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      }
    },
  );

  // R5.4a: how a candidate becomes an employer — requireAuth only, not
  // requireEmployer (nothing to gate yet; submitting a claim is how you
  // get one). domainVerified is computed server-side inside
  // submitEmployerClaim from request.user!.email, never client-supplied.
  app.post("/api/employer/claims", requireAuth, async (request: AuthenticatedRequest, response) => {
    const { companyId, representativeName, representativeRole, evidence } = request.body ?? {};

    if (typeof companyId !== "string" || companyId.trim() === "") {
      response.status(400).json({ error: "companyId is required" });
      return;
    }

    if (typeof representativeName !== "string" || representativeName.trim() === "") {
      response.status(400).json({ error: "representativeName is required" });
      return;
    }

    if (typeof representativeRole !== "string" || representativeRole.trim() === "") {
      response.status(400).json({ error: "representativeRole is required" });
      return;
    }

    try {
      const result = await submitEmployerClaim(resolveServiceClient(), {
        userId: request.user!.id,
        userEmail: request.user!.email,
        companyId,
        representativeName,
        representativeRole,
        evidence: typeof evidence === "string" ? evidence : undefined,
      });
      response.status(201).json(result);
    } catch (error) {
      if (error instanceof CompanyNotFoundError) {
        response.status(404).json({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: message });
    }
  });

  app.get("/api/moderation/employer-claims", requireAuth, requireModeratorOrAdmin, async (_request, response) => {
    try {
      const queue = await getEmployerClaimsQueue(resolveServiceClient());
      response.status(200).json(queue);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: message });
    }
  });

  app.post(
    "/api/moderation/employer-claims/:claimId/decision",
    requireAuth,
    requireModeratorOrAdmin,
    async (request: AuthenticatedRequest, response) => {
      const { decision, rationale } = request.body ?? {};

      if (!EMPLOYER_CLAIM_DECISIONS.includes(decision)) {
        response.status(400).json({ error: `decision must be one of: ${EMPLOYER_CLAIM_DECISIONS.join(", ")}` });
        return;
      }

      if (typeof rationale !== "string" || rationale.trim() === "") {
        response.status(400).json({ error: "rationale is required" });
        return;
      }

      try {
        const result = await submitEmployerClaimDecision(resolveServiceClient(), {
          claimId: request.params.claimId as string,
          reviewerId: request.user!.id,
          decision: decision as EmployerClaimDecisionValue,
          rationale,
        });
        response.status(201).json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      }
    },
  );

  // R5.4b: requireEmployerOfCompanyParam's first route — companyId comes
  // from the URL, so both the "does a verified claim exist" check and the
  // AAL2 check happen before any body parsing/validation below runs.
  app.post(
    "/api/employer/companies/:companyId/corrections",
    requireAuth,
    requireEmployerOfCompanyParam,
    async (request: AuthenticatedRequest, response) => {
      const { fieldName, proposedValue, evidence } = request.body ?? {};

      if (typeof fieldName !== "string" || !isCorrectableField(fieldName)) {
        response.status(400).json({ error: "fieldName must be one of the correctable fields." });
        return;
      }

      if (typeof proposedValue !== "string" || proposedValue.trim() === "") {
        response.status(400).json({ error: "proposedValue is required" });
        return;
      }

      try {
        const result = await submitCompanyFactCorrection(resolveServiceClient(), {
          userId: request.user!.id,
          companyId: request.params.companyId as string,
          fieldName,
          proposedValue,
          evidence: typeof evidence === "string" ? evidence : undefined,
        });
        response.status(201).json(result);
      } catch (error) {
        if (error instanceof InvalidProposedValueError) {
          response.status(400).json({ error: error.message });
          return;
        }
        if (error instanceof UnverifiedEmployerError) {
          response.status(403).json({ error: error.message });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      }
    },
  );

  app.get("/api/moderation/company-corrections", requireAuth, requireModeratorOrAdmin, async (_request, response) => {
    try {
      const queue = await getCompanyFactCorrectionsQueue(resolveServiceClient());
      response.status(200).json(queue);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: message });
    }
  });

  app.post(
    "/api/moderation/company-corrections/:correctionId/decision",
    requireAuth,
    requireModeratorOrAdmin,
    async (request: AuthenticatedRequest, response) => {
      const { decision, rationale } = request.body ?? {};

      if (!CORRECTION_DECISIONS.includes(decision)) {
        response.status(400).json({ error: `decision must be one of: ${CORRECTION_DECISIONS.join(", ")}` });
        return;
      }

      if (typeof rationale !== "string" || rationale.trim() === "") {
        response.status(400).json({ error: "rationale is required" });
        return;
      }

      try {
        const result = await submitCorrectionDecision(resolveServiceClient(), {
          correctionId: request.params.correctionId as string,
          reviewerId: request.user!.id,
          decision: decision as CorrectionDecisionValue,
          rationale,
        });
        response.status(201).json(result);
      } catch (error) {
        if (error instanceof CorrectionNotFoundError) {
          response.status(404).json({ error: error.message });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      }
    },
  );

  // R5.4c: which of this employer's vacancies are currently blocked, and
  // why — moderation_cases/moderation_decisions are service_role-only (no
  // authenticated grant at all), so this can't be an RLS-direct client
  // read the way listMyEmployerClaims is.
  app.get(
    "/api/employer/companies/:companyId/blocked-vacancies",
    requireAuth,
    requireEmployerOfCompanyParam,
    async (request: AuthenticatedRequest, response) => {
      try {
        const entries = await listEmployerBlockedVacancies(resolveServiceClient(), request.params.companyId as string);
        response.status(200).json(entries);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      }
    },
  );

  app.post(
    "/api/employer/appeals",
    requireAuth,
    requireEmployerOfCompanyBody,
    async (request: AuthenticatedRequest, response) => {
      const { companyId, vacancyId, rationale, evidence } = request.body ?? {};

      if (typeof vacancyId !== "string" || vacancyId.trim() === "") {
        response.status(400).json({ error: "vacancyId is required" });
        return;
      }

      if (typeof rationale !== "string" || rationale.trim() === "") {
        response.status(400).json({ error: "rationale is required" });
        return;
      }

      try {
        const result = await submitVacancyAppeal(resolveServiceClient(), {
          userId: request.user!.id,
          companyId: companyId as string,
          vacancyId,
          rationale,
          evidence: typeof evidence === "string" ? evidence : undefined,
        });
        response.status(201).json(result);
      } catch (error) {
        if (error instanceof UnverifiedEmployerAppealError) {
          response.status(403).json({ error: error.message });
          return;
        }
        if (error instanceof VacancyNotFoundError) {
          response.status(404).json({ error: error.message });
          return;
        }
        if (error instanceof DuplicatePendingAppealError) {
          response.status(409).json({ error: error.message });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      }
    },
  );

  // R5.4c: resolving an appeal reuses POST /api/moderation/cases/:caseId/decisions
  // unchanged — the moderator submits a decision against the appeal case's
  // own id with appealId set, which that route already accepted (R6.1-era
  // code, unused until now). No new decision-writing route needed.
  app.get("/api/moderation/appeals", requireAuth, requireModeratorOrAdmin, async (_request, response) => {
    try {
      const queue = await getAppealsQueue(resolveServiceClient());
      response.status(200).json(queue);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: message });
    }
  });

  // MP-W2: triggers the MP-W1 batch entrypoint (same runApplicationBatch
  // npm run worker:applications already calls) over HTTP, for an external
  // scheduler (cron) rather than a signed-in candidate/moderator — see
  // requireWorkerSecret.ts for why this isn't requireAuth/requireModerator
  // or the raw service-role key. runApplicationBatch's own idempotency
  // (getOrCreatePlan) and leasing (claim_application_attempt's FOR UPDATE
  // SKIP LOCKED) already make overlapping/concurrent triggers safe, so no
  // additional "already running" guard is added here.
  app.post("/api/worker/run", requireWorkerSecret, async (_request, response) => {
    try {
      const result = await runApplicationBatch(resolveServiceClient());
      response.status(200).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Worker run failed:", message);
      response.status(500).json({ error: "Failed to run application batch" });
    }
  });

  // Task U: releases one application_attempts row that is being held for the
  // candidate's review, preparing its resume first so the worker that later
  // claims it dispatches a file that already exists rather than generating one
  // at that moment.
  //
  // AUTHENTICATED BY WORKER SECRET, NOT BY A CANDIDATE SESSION, and that is a
  // limitation worth naming rather than hiding: the caller cannot be tied to
  // the candidate who owns the attempt, so this route can approve any held
  // attempt. It is the stand-in for the candidate's own approval until a
  // candidate-authenticated route exists (requireAuth + an ownership check on
  // application_plans.candidate_id), which is the natural next step — see the
  // summary. Kept behind the worker secret rather than left unauthenticated so
  // that the interim state is at least not open to the internet.
  app.post("/api/worker/approve-attempt", requireWorkerSecret, async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const applicationAttemptId =
      typeof body.applicationAttemptId === "string" ? body.applicationAttemptId.trim() : "";

    if (!applicationAttemptId) {
      response.status(400).json({ error: "applicationAttemptId is required" });
      return;
    }

    try {
      const result = await approveAttempt(
        resolveServiceClient(),
        { createOpenAIClient: resolveOpenAIClient },
        { applicationAttemptId },
      );

      response.status(200).json({
        applicationAttemptId: result.applicationAttemptId,
        status: result.status,
        reviewApprovedAt: result.reviewApprovedAt,
        resumePrepared: result.resumePrepared,
        resume: {
          documentId: result.resume.documentId,
          originalFilename: result.resume.originalFilename,
          tailored: result.resume.tailored,
          optimizationLevel: result.resume.optimizationLevel,
        },
      });
    } catch (error) {
      if (error instanceof ApplicationAttemptNotFoundError) {
        response.status(404).json({ error: "Application attempt not found" });
        return;
      }

      if (error instanceof AttemptNotAwaitingReviewError) {
        // 409, not 400: the request is well-formed, it just conflicts with the
        // row's current state — already approved, already submitted, or never
        // held. The status is echoed so the caller can tell those apart.
        response.status(409).json({
          error: "Application attempt is not awaiting review",
          status: error.status,
          detail: error.detail ?? null,
        });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      console.error("Approve attempt failed:", message);
      response.status(500).json({ error: "Failed to approve application attempt" });
    }
  });

  // R6.3 Response Intelligence: backfill/retry classification of stored
  // messages, for the same external scheduler as /api/worker/run. Fresh
  // mail is classified inline during the mailbox poll; this drains the
  // backlog and anything the poll couldn't classify.
  app.post("/api/worker/classify-messages", requireWorkerSecret, async (_request, response) => {
    try {
      const result = await runMessageClassificationBatch(resolveServiceClient(), resolveOpenAIClient());
      response.status(200).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Message classification run failed:", message);
      response.status(500).json({ error: "Failed to run message classification batch" });
    }
  });

  // R6.3 Response Intelligence Phase 3: link classified-but-unlinked
  // messages to the owning candidate's application attempts. Runs after
  // /api/worker/classify-messages on the same external scheduler; safe to
  // re-run (only touches messages whose application_attempt_id IS NULL).
  app.post("/api/worker/match-messages", requireWorkerSecret, async (_request, response) => {
    try {
      const result = await runApplicationMatchBatch(resolveServiceClient());
      response.status(200).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Message match run failed:", message);
      response.status(500).json({ error: "Failed to run message match batch" });
    }
  });

  // Response Intelligence Phase 2.1: drains fit_analysis_jobs (JD extraction
  // + AI Technical Fit + rules-engine Practical Eligibility). Same external
  // scheduler as the other /api/worker/* routes; leasing + upsert make
  // overlapping triggers safe.
  app.post("/api/worker/run-fit", requireWorkerSecret, async (_request, response) => {
    try {
      const result = await runFitAnalysisBatch(resolveServiceClient(), { openai: resolveOpenAIClient() });
      response.status(200).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Fit analysis run failed:", message);
      response.status(500).json({ error: "Failed to run fit analysis batch" });
    }
  });

  // R8.1 Admin Operations Panel — Overview: three real counts only. MRR and
  // error/unresolved counts are deliberately absent (no subscriptions or
  // error_events table exists yet).
  app.get("/api/admin/overview", requireAuth, requireAdmin, async (_request, response) => {
    try {
      const overview = await getAdminOverview(resolveServiceClient());
      response.status(200).json(overview);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: message });
    }
  });

  app.get("/api/admin/sources", requireAuth, requireAdmin, async (_request, response) => {
    try {
      const sources = await listSourcePolicies(resolveServiceClient());
      response.status(200).json(sources);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: message });
    }
  });

  app.patch(
    "/api/admin/sources/:sourceCode",
    requireAuth,
    requireAdmin,
    async (request: AuthenticatedRequest, response) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const patch: Partial<Record<EditableSourcePolicyField, boolean>> = {};

      for (const key of Object.keys(body)) {
        if (!(EDITABLE_SOURCE_POLICY_FIELDS as readonly string[]).includes(key)) {
          response.status(400).json({ error: `${key} is not an editable field.` });
          return;
        }
        if (typeof body[key] !== "boolean") {
          response.status(400).json({ error: `${key} must be a boolean.` });
          return;
        }
        patch[key as EditableSourcePolicyField] = body[key] as boolean;
      }

      if (Object.keys(patch).length === 0) {
        response.status(400).json({ error: "At least one editable field is required." });
        return;
      }

      try {
        const updated = await updateSourcePolicy(resolveServiceClient(), request.params.sourceCode as string, patch);
        response.status(200).json(updated);
      } catch (error) {
        if (error instanceof SourcePolicyNotFoundError) {
          response.status(404).json({ error: error.message });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      }
    },
  );

  /**
   * Source health: the per-run fetch log in source_health_events (PRD §21.1).
   *
   * READ-ONLY BY CONSTRUCTION, not by convention — the table grants service_role
   * SELECT and INSERT only, so there is no update or delete for this route to
   * expose. What it deliberately does NOT show: a policy refusal (kill switch,
   * discovery disabled, no policy row) is thrown before the fetch and writes no
   * row at all, and a rate limit is recorded as status 'error' with the status
   * code only in error_message. Both are stated in the UI.
   */
  app.get("/api/admin/source-health", requireAuth, requireAdmin, async (request, response) => {
    const query = request.query as Record<string, unknown>;

    const parsedLimit = parseLimitQuery(query.limit);

    if (!parsedLimit.ok) {
      response.status(400).json({ error: "limit must be a positive integer" });
      return;
    }

    const rawStatus = query.status;

    if (rawStatus !== undefined && !isSourceHealthStatus(rawStatus)) {
      response.status(400).json({ error: "status must be one of " + SOURCE_HEALTH_STATUSES.join(", ") });
      return;
    }

    // A blank sourceCode is treated as "no filter" rather than refused: the
    // select that sends it has an "All sources" option whose value is empty.
    const rawSourceCode = query.sourceCode;
    const sourceCode =
      typeof rawSourceCode === "string" && rawSourceCode.trim() !== "" ? rawSourceCode.trim() : null;

    try {
      const health = await listSourceHealthEvents(resolveServiceClient(), {
        limit: parsedLimit.limit,
        sourceCode,
        status: isSourceHealthStatus(rawStatus) ? rawStatus : null,
      });
      response.status(200).json(health);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Source health read failed:", message);
      response.status(500).json({ error: "Failed to load source health" });
    }
  });

  // -------------------------------------------------------------------------
  // Queue observability, dead-letter retry, and admin-triggered worker runs.
  //
  // WHY TRIGGERS LIVE HERE AND NOT BEHIND /api/worker/*. Those routes are
  // authenticated by WORKER_TRIGGER_SECRET, which the browser cannot hold and
  // must not — putting it there would hand every admin session the credential an
  // external cron uses. These call the same functions behind requireAuth +
  // requireAdmin instead, so the browser never sees a shared secret. They do not
  // replace /api/worker/*; an external cron still has no session.
  //
  // EVERY TRIGGER IS AUDITED, success or failure, because "who ran the ingestion
  // batch that spent the Jooble quota" is the first question anyone asks.
  // -------------------------------------------------------------------------

  app.get("/api/admin/queues", requireAuth, requireAdmin, async (_request, response) => {
    try {
      const overview = await listQueues(resolveServiceClient());
      response.status(200).json(overview);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Queue overview read failed:", message);
      response.status(500).json({ error: "Failed to load queue state" });
    }
  });

  app.post(
    "/api/admin/queues/:queue/:jobId/retry",
    requireAuth,
    requireAdmin,
    async (request: AuthenticatedRequest, response) => {
      const queue = request.params.queue;
      const jobId = request.params.jobId as string;

      if (!isQueueName(queue)) {
        response.status(400).json({ error: "queue must be one of " + QUEUE_NAMES.join(", ") });
        return;
      }

      if (!UUID_PATTERN.test(jobId)) {
        response.status(400).json({ error: "jobId must be a uuid" });
        return;
      }

      try {
        const client = resolveServiceClient();
        const rearmed = await rearmFailedJob(client, queue, jobId);

        if (!rearmed) {
          // Only a dead-lettered row can be re-armed, so nothing matching means
          // the id is wrong or the row is not failed — both a 404 rather than a
          // success that changed nothing.
          response.status(404).json({ error: "No failed job with that id in that queue." });
          return;
        }

        await recordAuditEvent(client, {
          actorId: request.user!.id,
          actorRole: "admin",
          action: "queue_job.retried",
          entityType: "queue_job",
          entityId: jobId,
          summary: "Re-armed a failed job in " + queue,
          previousValues: { status: "failed" },
          newValues: { status: "pending", attempts: 0 },
        });

        response.status(200).json({ queue, jobId, rearmed: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Queue job re-arm failed:", message);
        response.status(500).json({ error: "Failed to re-arm the job" });
      }
    },
  );

  app.post(
    "/api/admin/worker/:task",
    requireAuth,
    requireAdmin,
    adminWorkerRunRateLimit,
    async (request: AuthenticatedRequest, response) => {
      const task = request.params.task;

      if (!isAdminWorkerTask(task)) {
        response.status(400).json({ error: "task must be one of " + ADMIN_WORKER_TASKS.join(", ") });
        return;
      }

      // Declared outside the try so the failure path can still audit with the
      // same client; resolveServiceClient itself can throw on a misconfigured
      // deployment, and auditing that has to be best-effort rather than fatal.
      let client: SupabaseClient | undefined;

      try {
        client = resolveServiceClient();

        const result = await runAdminWorkerTask(client, task, {
          openai: resolveOpenAIClient,
          googleOAuthConfig: resolveGoogleOAuthConfig,
          mailboxEncryptionKey: resolveMailboxEncryptionKey,
        });

        await recordAuditEvent(client, {
          actorId: request.user!.id,
          actorRole: "admin",
          action: "worker.triggered",
          entityType: "worker_task",
          entityId: task,
          summary: "Ran the " + task + " worker batch",
          newValues: result,
        });

        response.status(200).json({ task, result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (client) {
          await recordAuditEvent(client, {
            actorId: request.user!.id,
            actorRole: "admin",
            action: "worker.trigger_failed",
            entityType: "worker_task",
            entityId: task,
            summary: "The " + task + " worker batch could not run: " + message,
            newValues: { error: message },
          });
        }

        if (error instanceof WorkerTaskNotConfiguredError) {
          // A deployment problem, not the caller's fault, and the fix is an
          // environment variable — so say which one rather than a generic 500.
          response.status(503).json({ error: message });
          return;
        }

        console.error("Admin worker trigger failed:", message);
        response.status(500).json({ error: "Failed to run the worker batch" });
      }
    },
  );

  app.get("/api/admin/trust-scores", requireAuth, requireAdmin, async (_request, response) => {
    try {
      const scores = await getRecentTrustScores(resolveServiceClient());
      response.status(200).json(scores);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: message });
    }
  });

  // Read-only — the §12.2 weights are PRD-verified constants (trustScore.ts),
  // not stored config; this only displays them. R8.1 explicitly defers
  // making them editable.
  app.get("/api/admin/trust-weights", requireAuth, requireAdmin, (_request, response) => {
    response.status(200).json(DIMENSION_WEIGHTS);
  });

  // -------------------------------------------------------------------------
  // Task H1 — billing.
  // -------------------------------------------------------------------------

  // The same origin the mailbox OAuth flow redirects to. CLIENT_APP_URL is a
  // general setting; mailboxClientAppUrl's name is historical.
  const clientAppUrl = mailboxClientAppUrl;

  // Candidate-facing plan catalogue. Every region and interval is returned,
  // including the ones that are deliberately unpriced, so the pricing screen can
  // show "not priced yet" for a region instead of silently omitting it and
  // looking broken.
  app.get("/api/billing/plans", requireAuth, async (_request, response) => {
    try {
      const plans = await listPlans(resolveServiceClient());
      response.status(200).json({
        plans: plans.filter((plan) => plan.isActive).map((plan) => ({
          code: plan.code,
          displayName: plan.displayName,
          description: plan.description,
          tierRank: plan.tierRank,
          limits: plan.limits,
          prices: plan.prices,
        })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Billing plans read failed:", message);
      response.status(500).json({ error: "Failed to load plans" });
    }
  });

  // The caller's own subscription plus every §27.2 dimension evaluated against
  // their current usage. Read-only.
  app.get("/api/billing/subscription", requireAuth, async (request: AuthenticatedRequest, response) => {
    try {
      const client = resolveServiceClient();
      const [subscription, entitlements] = await Promise.all([
        getCandidateSubscription(client, request.user!.id),
        evaluateEntitlements(client, request.user!.id),
      ]);

      // WHICH PROVIDERS ARE CONFIGURED rides along with the subscription, and it
      // is deliberately a boolean rather than the key ids. The client needs to
      // know whether to offer Checkout or the early-access fallback, and it must
      // not be able to learn a secret from this response. The Razorpay key ID is
      // returned by the order route instead, so rotating the key needs no
      // rebuild and no redeploy of the client bundle.
      response.status(200).json({
        subscription,
        entitlements,
        providers: {
          razorpayConfigured: readRazorpayConfig() !== null,
          stripeConfigured: readStripeConfig() !== null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Billing subscription read failed:", message);
      response.status(500).json({ error: "Failed to load subscription" });
    }
  });

  // Plan selection. Creates a real Stripe Checkout Session, or explains that
  // billing is not configured — it never returns a placeholder URL.
  app.post("/api/billing/checkout-session", requireAuth, async (request: AuthenticatedRequest, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const planCode = typeof body.planCode === "string" ? body.planCode.trim() : "";
    const region = body.region;
    const interval = body.billingInterval;

    if (!planCode) {
      response.status(400).json({ error: "planCode is required" });
      return;
    }

    if (!isBillingRegion(region)) {
      // Built from the region list rather than spelled out, so adding a region
      // cannot leave this message naming the old set.
      response.status(400).json({ error: "region must be one of " + BILLING_REGIONS.join(", ") });
      return;
    }

    if (!isBillingInterval(interval)) {
      response.status(400).json({ error: "billingInterval must be one of month, year" });
      return;
    }

    try {
      const client = resolveServiceClient();

      const existing = await getCandidateSubscription(client, request.user!.id);
      if (existing) {
        response.status(409).json({ error: "You already have an active subscription.", status: existing.status });
        return;
      }

      const plans = await listPlans(client);
      const plan = plans.find((entry) => entry.code === planCode && entry.isActive);

      if (!plan) {
        response.status(404).json({ error: "No such plan" });
        return;
      }

      const price = findActivePrice(plan, region, interval);

      if (!price || price.amountMinor === null) {
        // A real, common state: this region/interval has no founder-set price.
        // 409 rather than 400 because the request was well-formed and the
        // catalogue is what lacks the answer.
        response.status(409).json({ error: "This plan is not priced for that region and billing period yet." });
        return;
      }

      // A zero-price plan must never reach a payment provider. Checked on the
      // AMOUNT rather than the plan code so it holds for any future plan priced
      // at zero: a Stripe session for £0 is either a broken checkout or a free
      // upgrade path that still takes a card. 400 rather than 409 because the
      // request is wrong, not the catalogue.
      if (price.amountMinor === 0) {
        response.status(400).json({
          error: "The Free plan costs nothing and needs no payment, so it cannot be checked out.",
        });
        return;
      }

      const result = await createCheckoutSession(readStripeConfig(), {
        planCode: plan.code,
        planDisplayName: plan.displayName,
        amountMinor: price.amountMinor,
        region: price.region,
        currency: price.currency,
        billingInterval: price.billingInterval,
        candidateId: request.user!.id,
        successUrl: clientAppUrl + "/#/billing?checkout=success",
        cancelUrl: clientAppUrl + "/#/billing?checkout=cancelled",
      });

      if (result.kind === "not_configured") {
        response.status(503).json({
          error: "Card payments are not configured yet. No payment provider credentials are set on this deployment.",
        });
        return;
      }

      if (result.kind === "error") {
        response.status(502).json({ error: result.message });
        return;
      }

      response.status(200).json({ sessionId: result.sessionId, url: result.url });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Checkout session creation failed:", message);
      response.status(500).json({ error: "Failed to start checkout" });
    }
  });

  // Cancellation. Schedule-to-end when there is a paid period, immediate when
  // there is not — see cancelCandidateSubscription.
  app.post("/api/billing/cancel", requireAuth, async (request: AuthenticatedRequest, response) => {
    try {
      const result = await cancelCandidateSubscription(resolveServiceClient(), request.user!.id);

      if (result.kind === "no_subscription") {
        response.status(404).json({ error: "No active subscription to cancel." });
        return;
      }

      // Task H4: a billing change is a money-affecting action on a candidate's
      // account, so it is audited with the previous state.
      await recordAuditEvent(resolveServiceClient(), {
        actorId: request.user!.id,
        actorRole: "candidate",
        action: "subscription.cancelled",
        entityType: "subscription",
        entityId: result.subscription.id,
        summary: "Cancelled the " + result.subscription.planCode + " subscription",
        previousValues: { status: "active", cancelAtPeriodEnd: false },
        newValues: {
          status: result.subscription.status,
          cancelAtPeriodEnd: result.subscription.cancelAtPeriodEnd,
        },
      });

      response.status(200).json({
        subscription: result.subscription,
        note: result.subscription.cancelAtPeriodEnd
          ? "Your plan will end at the close of the current billing period."
          : "Your plan has been cancelled.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Subscription cancellation failed:", message);
      response.status(500).json({ error: "Failed to cancel subscription" });
    }
  });

  // R8.1's "Users & Billing" section. Replaces a hardcoded mock; every figure
  // is computed from the tables above, and MRR is per currency because no
  // exchange-rate source exists to blend them.
  // ---------------------------------------------------------------------------
  // R5 — early-access plan selection.
  //
  // POST /api/billing/select-plan
  //
  // THE FALLBACK THAT CLOSES ITSELF. This grants a paid plan and takes no money.
  // The guard below refuses whenever the region's real provider is configured —
  // Razorpay for IN, Stripe for US/UK/EU — so the moment credentials are added
  // this stops being an upgrade path and the UI sends the candidate to Checkout
  // instead. The candidate id comes from the verified token, so it can only ever
  // change the caller's own plan, and every activation is audited.
  //
  // See server/billing/selectPlan.ts for why this exists at all and what bounds
  // it. It is a deliberate pre-launch decision, not an oversight.
  // ---------------------------------------------------------------------------
  app.post("/api/billing/select-plan", requireAuth, async (request: AuthenticatedRequest, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const planCode = typeof body.planCode === "string" ? body.planCode.trim() : "";
    const region = body.region;

    if (!planCode) {
      response.status(400).json({ error: "planCode is required" });
      return;
    }

    if (!isBillingRegion(region)) {
      response.status(400).json({ error: "region must be one of " + BILLING_REGIONS.join(", ") });
      return;
    }

    try {
      const client = resolveServiceClient();

      // One provider per region: Razorpay is India-first, Stripe covers the rest.
      const providerConfigured = region === "IN" ? readRazorpayConfig() !== null : readStripeConfig() !== null;

      if (providerConfigured) {
        response.status(409).json({
          error: "Payments are configured for this region, so use checkout instead of selecting a plan directly.",
        });
        return;
      }

      const plans = await listPlans(client);
      const plan = plans.find((entry) => entry.code === planCode && entry.isActive);

      if (!plan) {
        response.status(404).json({ error: "No such plan" });
        return;
      }

      const result = await selectCandidatePlan(client, {
        candidateId: request.user!.id,
        planCode,
        region,
        currency: REGION_CURRENCY[region],
      });

      if (result.kind === "unknown_plan") {
        response.status(404).json({ error: "No such plan" });
        return;
      }

      if (result.kind === "failed") {
        response.status(500).json({ error: result.message });
        return;
      }

      await recordAuditEvent(client, {
        actorId: request.user!.id,
        actorRole: "candidate",
        action: result.kind === "downgraded" ? "subscription.downgraded" : "subscription.activated_early_access",
        entityType: "subscription",
        entityId: result.kind === "activated" ? result.subscriptionId : null,
        summary:
          result.kind === "downgraded"
            ? "Candidate moved themselves to the Free plan"
            : "Candidate activated " + plan.displayName + " under early access with no charge taken",
        newValues: { planCode, region, provider: result.kind === "downgraded" ? null : "manual" },
      });

      const [subscription, entitlements] = await Promise.all([
        getCandidateSubscription(client, request.user!.id),
        evaluateEntitlements(client, request.user!.id),
      ]);

      response.set("Cache-Control", "no-store");
      response.status(200).json({ subscription, entitlements });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Plan selection failed:", message);
      response.status(500).json({ error: "Failed to select plan" });
    }
  });

  // ---------------------------------------------------------------------------
  // R5 — Razorpay order creation (India / INR).
  //
  // POST /api/billing/razorpay/order
  //
  // THE ORDER CARRIES THE METADATA THE REST OF THE FLOW TRUSTS: the candidate id
  // and the plan code go into the order's notes, and Razorpay copies notes onto
  // the payment. Both the callback verifier and the webhook read the plan back
  // out of the ORDER rather than from a request body, which is what stops a
  // candidate paying for Starter and claiming Power.
  //
  // The key ID is returned HERE rather than baked into the client bundle as a
  // VITE_ variable, so rotating the key needs no rebuild and no redeploy.
  // ---------------------------------------------------------------------------
  app.post("/api/billing/razorpay/order", requireAuth, async (request: AuthenticatedRequest, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const planCode = typeof body.planCode === "string" ? body.planCode.trim() : "";
    const region = body.region;

    if (!planCode) {
      response.status(400).json({ error: "planCode is required" });
      return;
    }

    if (!isBillingRegion(region)) {
      response.status(400).json({ error: "region must be one of " + BILLING_REGIONS.join(", ") });
      return;
    }

    if (region !== "IN") {
      response.status(400).json({
        error: "Razorpay handles India (INR) pricing. Use the checkout route for US, UK and EU.",
      });
      return;
    }

    const config = readRazorpayConfig();

    if (!config) {
      response.status(503).json({
        error: "Razorpay is not configured yet. No Razorpay credentials are set on this deployment.",
      });
      return;
    }

    try {
      const client = resolveServiceClient();
      const plans = await listPlans(client);
      const plan = plans.find((entry) => entry.code === planCode && entry.isActive);

      if (!plan) {
        response.status(404).json({ error: "No such plan" });
        return;
      }

      const price = findActivePrice(plan, region, "month");

      if (!price || price.amountMinor === null) {
        response.status(409).json({ error: "This plan is not priced for that region yet." });
        return;
      }

      // Checked on the AMOUNT rather than the plan code, so it holds for any
      // future zero-priced plan: an order for 0 paise is either a broken checkout
      // or a free upgrade that still takes a card.
      if (price.amountMinor === 0) {
        response.status(400).json({
          error: "The Free plan costs nothing and needs no payment, so it cannot be ordered.",
        });
        return;
      }

      const result = await createRazorpayOrder(config, {
        planCode: plan.code,
        planDisplayName: plan.displayName,
        amountMinor: price.amountMinor,
        currency: price.currency,
        region: price.region,
        billingInterval: "month",
        candidateId: request.user!.id,
      });

      if (result.kind === "not_configured") {
        response.status(503).json({ error: "Razorpay is not configured yet." });
        return;
      }

      if (result.kind === "error") {
        response.status(502).json({ error: result.message });
        return;
      }

      response.set("Cache-Control", "no-store");
      response.status(200).json({
        orderId: result.orderId,
        amountMinor: result.amountMinor,
        currency: result.currency,
        keyId: result.keyId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Razorpay order creation failed:", message);
      response.status(500).json({ error: "Failed to start checkout" });
    }
  });

  // ---------------------------------------------------------------------------
  // R5 — Razorpay checkout callback verification.
  //
  // POST /api/billing/razorpay/verify
  //
  // TWO CHECKS, AND BOTH MATTER:
  //   1. The HMAC over "order_id|payment_id" proves the payment happened.
  //   2. THE ORDER IS FETCHED BACK FROM RAZORPAY and the plan, region and
  //      currency are read from ITS notes. The signature says nothing about
  //      which plan was bought, so without this a candidate could pay for
  //      Starter and then ask for Power with a perfectly valid signature. The
  //      candidate id in those notes is compared to the verified caller, so one
  //      account cannot claim another's paid order either.
  //
  // The request body therefore carries only the three Razorpay fields. Nothing
  // the browser says about the plan is used.
  // ---------------------------------------------------------------------------
  app.post("/api/billing/razorpay/verify", requireAuth, async (request: AuthenticatedRequest, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const orderId = typeof body.razorpay_order_id === "string" ? body.razorpay_order_id : "";
    const paymentId = typeof body.razorpay_payment_id === "string" ? body.razorpay_payment_id : "";
    const signature = typeof body.razorpay_signature === "string" ? body.razorpay_signature : "";

    if (!orderId || !paymentId || !signature) {
      response.status(400).json({
        error: "razorpay_order_id, razorpay_payment_id and razorpay_signature are required",
      });
      return;
    }

    const config = readRazorpayConfig();

    if (!config) {
      response.status(503).json({ error: "Razorpay is not configured yet." });
      return;
    }

    if (!verifyRazorpayCallbackSignature(orderId, paymentId, signature, config.keySecret)) {
      response.status(400).json({ error: "Invalid payment signature." });
      return;
    }

    try {
      const client = resolveServiceClient();
      const orderResult = await fetchRazorpayOrder(config, orderId);

      if (orderResult.kind === "error") {
        response.status(502).json({ error: orderResult.message });
        return;
      }

      const notes = orderResult.order.notes;
      const candidateId = notes.candidate_id ?? "";
      const planCode = notes.plan_code ?? "";
      const region = notes.region ?? "";
      const currency = notes.currency ?? "";
      const interval = notes.billing_interval === "year" ? "year" : "month";

      if (candidateId !== request.user!.id) {
        // 404, not 403: a 403 would confirm that the order id names a real order
        // belonging to somebody else, turning this into an oracle for probing ids.
        response.status(404).json({ error: "That order does not belong to this account." });
        return;
      }

      if (!planCode || !isBillingRegion(region) || currency === "") {
        response.status(409).json({ error: "That order is missing the details needed to activate a plan." });
        return;
      }

      const applied = await applyCheckoutCompleted(client, {
        candidateId,
        planCode,
        provider: "razorpay",
        providerCustomerId: null,
        providerSubscriptionId: paymentId,
        region,
        currency,
        billingInterval: interval,
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: null,
      });

      if (applied.kind === "unknown_plan") {
        response.status(404).json({ error: "No such plan" });
        return;
      }

      await recordAuditEvent(client, {
        actorId: request.user!.id,
        actorRole: "candidate",
        action: "subscription.activated",
        entityType: "subscription",
        entityId: applied.subscriptionId,
        summary: "Activated " + planCode + " via Razorpay payment " + paymentId,
        newValues: { planCode, region, currency, provider: "razorpay", orderId },
      });

      const [subscription, entitlements] = await Promise.all([
        getCandidateSubscription(client, request.user!.id),
        evaluateEntitlements(client, request.user!.id),
      ]);

      response.set("Cache-Control", "no-store");
      response.status(200).json({ subscription, entitlements });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Razorpay verification failed:", message);
      response.status(500).json({ error: "Failed to verify payment" });
    }
  });

  app.get("/api/admin/billing", requireAuth, requireAdmin, async (_request, response) => {
    try {
      const billing = await getAdminBilling(resolveServiceClient());
      response.status(200).json(billing);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Admin billing read failed:", message);
      response.status(500).json({ error: "Failed to load billing data" });
    }
  });

  // -------------------------------------------------------------------------
  // Role management — granting and revoking 'admin' / 'moderator' from the
  // Users & Billing section instead of by hand-written SQL after bootstrap.
  //
  // ALL THREE ARE requireAuth + requireAdmin, and that pair is the real
  // boundary: public.user_roles is service_role-only at the database grant
  // level (20260816222822_user_roles.sql), so this route family is the only
  // write path a role ever takes. Hiding the UI would not revoke the ability.
  // -------------------------------------------------------------------------

  app.get("/api/admin/roles", requireAuth, requireAdmin, async (request: AuthenticatedRequest, response) => {
    try {
      const { assignments, truncated } = await listRoleAssignments(resolveServiceClient());
      response.status(200).json({
        // isSelf comes from the verified token, never from the request body or
        // query — and it only ever disables a button. The delete route below
        // refuses the self-revocation regardless of what the client sends.
        assignments: assignments.map((assignment) => ({
          ...assignment,
          isSelf: assignment.userId === request.user!.id,
        })),
        truncated,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Admin roles read failed:", message);
      response.status(500).json({ error: "Failed to load role assignments" });
    }
  });

  app.post("/api/admin/roles", requireAuth, requireAdmin, async (request: AuthenticatedRequest, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const role = body.role;

    if (email === "") {
      response.status(400).json({ error: "email is required" });
      return;
    }

    if (!isManageableRole(role)) {
      response.status(400).json({ error: "role must be one of " + MANAGEABLE_ROLES.join(", ") });
      return;
    }

    try {
      const client = resolveServiceClient();
      const user = await findUserByEmail(client, email);

      if (!user) {
        // A real 404 rather than a silent success: the admin named an address
        // with no registered account, and granting a role to nobody must not
        // be reported as having granted it.
        response.status(404).json({ error: "No registered user with that email address." });
        return;
      }

      const { alreadyHeld } = await grantRole(client, user.id, role);

      // Audited only on a state change: an audit row asserting a grant that
      // changed nothing would be the more misleading record, and the response
      // already tells the caller which of the two happened.
      if (!alreadyHeld) {
        await recordAuditEvent(client, {
          actorId: request.user!.id,
          actorRole: "admin",
          action: "role.granted",
          entityType: "user_role",
          entityId: user.id,
          summary: "Granted the " + role + " role to " + (user.email ?? email),
          previousValues: null,
          newValues: { userId: user.id, email: user.email, role },
        });
      }

      response.status(200).json({ userId: user.id, email: user.email ?? email, role, alreadyHeld });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Admin role grant failed:", message);
      response.status(500).json({ error: "Failed to grant the role" });
    }
  });

  // Path params rather than a DELETE request body: a body on DELETE is legal
  // HTTP but a reverse proxy is free to strip it, which would turn a revoke
  // into an unmatched request in production while working perfectly in dev.
  app.delete(
    "/api/admin/roles/:userId/:role",
    requireAuth,
    requireAdmin,
    async (request: AuthenticatedRequest, response) => {
      const userId = request.params.userId as string;
      const role = request.params.role;

      if (!UUID_PATTERN.test(userId)) {
        response.status(400).json({ error: "userId must be a uuid" });
        return;
      }

      if (!isManageableRole(role)) {
        response.status(400).json({ error: "role must be one of " + MANAGEABLE_ROLES.join(", ") });
        return;
      }

      // Self-lockout guard: the caller's own admin row is the access that
      // reaches this console at all, and revoking it takes effect immediately
      // (isAdmin is read per request). Refused before any write is attempted.
      if (userId === request.user!.id && role === "admin") {
        response.status(400).json({ error: "You cannot revoke your own admin role." });
        return;
      }

      try {
        const client = resolveServiceClient();
        const removed = await revokeRole(client, userId, role);

        if (removed) {
          await recordAuditEvent(client, {
            actorId: request.user!.id,
            actorRole: "admin",
            action: "role.revoked",
            entityType: "user_role",
            entityId: userId,
            summary: "Revoked the " + role + " role from user " + userId,
            previousValues: { userId, role },
            newValues: null,
          });
        }

        response.status(200).json({ userId, role, removed });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Admin role revoke failed:", message);
        response.status(500).json({ error: "Failed to revoke the role" });
      }
    },
  );

  // -------------------------------------------------------------------------
  // Task H4 — audit, security events, and ATS credential administration.
  // -------------------------------------------------------------------------

  /** The system audit trail (PRD v3 §21.1). Read-only: nothing can write through this route. */
  app.get("/api/admin/audit-events", requireAuth, requireAdmin, async (request, response) => {
    const parsedLimit = parseLimitQuery((request.query as Record<string, unknown>).limit);

    if (!parsedLimit.ok) {
      response.status(400).json({ error: "limit must be a positive integer" });
      return;
    }

    try {
      const { events, limit, truncated } = await listAuditEvents(resolveServiceClient(), { limit: parsedLimit.limit });
      response.status(200).json({ events, limit, truncated });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Audit events read failed:", message);
      response.status(500).json({ error: "Failed to load audit events" });
    }
  });

  /** Detections from the RI PRD §10.3 defences. Read-only. */
  app.get("/api/admin/security-events", requireAuth, requireAdmin, async (request, response) => {
    const parsedLimit = parseLimitQuery((request.query as Record<string, unknown>).limit);

    if (!parsedLimit.ok) {
      response.status(400).json({ error: "limit must be a positive integer" });
      return;
    }

    try {
      const { events, limit, truncated } = await listSecurityEvents(resolveServiceClient(), { limit: parsedLimit.limit });
      response.status(200).json({ events, limit, truncated });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Security events read failed:", message);
      response.status(500).json({ error: "Failed to load security events" });
    }
  });

  /**
   * ATS credentials, summaries only.
   *
   * THE SECRET IS NEVER IN THIS RESPONSE, and that is the whole design of this
   * route. listAtsCredentials does not select secret_ciphertext at all, so there
   * is no code path here that could return a key even by accident, and no
   * "include the secret?" flag for a later change to get wrong. An operator sees
   * which source, which employer, and the last four characters — enough to
   * manage a rotation, useless for using the key.
   */
  app.get("/api/admin/ats-credentials", requireAuth, requireAdmin, async (_request, response) => {
    try {
      const credentials = await listAtsCredentials(resolveServiceClient());
      response.status(200).json({ credentials });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("ATS credentials read failed:", message);
      response.status(500).json({ error: "Failed to load ATS credentials" });
    }
  });

  /**
   * Install or rotate an employer credential.
   *
   * The secret arrives in full exactly once, is encrypted immediately, and is
   * never returned. Audited, because "who installed the key that submitted this
   * application" is the first question anyone asks when an application turns out
   * to be wrong.
   */
  app.post("/api/admin/ats-credentials", requireAuth, requireAdmin, async (request: AuthenticatedRequest, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const sourceCode = typeof body.sourceCode === "string" ? body.sourceCode.trim() : "";
    const employerKey = typeof body.employerKey === "string" ? body.employerKey.trim() : "";
    const secret = typeof body.secret === "string" ? body.secret : "";
    const label = typeof body.label === "string" && body.label.trim() !== "" ? body.label.trim() : null;

    if (!(ATS_SOURCE_CODES as readonly string[]).includes(sourceCode)) {
      response.status(400).json({ error: "sourceCode must be one of " + ATS_SOURCE_CODES.join(", ") });
      return;
    }

    if (!employerKey) {
      // Named explicitly because it is the field people skip: the key is scoped
      // to one employer, so storing it without knowing whose it is makes it
      // unusable and dangerous at the same time.
      response.status(400).json({ error: "employerKey is required — a credential authorizes one employer's board or account." });
      return;
    }

    if (secret.trim() === "") {
      response.status(400).json({ error: "secret is required" });
      return;
    }

    try {
      const client = resolveServiceClient();
      const stored = await storeAtsCredential(client, {
        sourceCode: sourceCode as AtsSourceCode,
        employerKey,
        secret,
        label,
      });

      await recordAuditEvent(client, {
        actorId: request.user!.id,
        actorRole: "admin",
        action: "ats_credential.stored",
        entityType: "ats_credential",
        entityId: stored.id,
        // The hint identifies the key; the key itself must never reach this table.
        summary: "Installed a " + sourceCode + " credential for employer " + employerKey + " (key ending " + secret.trim().slice(-4) + ")",
        newValues: { sourceCode, employerKey, label, keyHint: secret.trim().slice(-4) },
      });

      response.status(200).json({ id: stored.id, sourceCode, employerKey, keyHint: secret.trim().slice(-4) });
    } catch (error) {
      if (error instanceof AtsCredentialKeyError) {
        // A deployment problem, not the caller's fault, and the fix is an
        // environment variable — so say so rather than returning a generic 500.
        response.status(503).json({ error: "ATS credential storage is not configured on this deployment.", reason: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error("ATS credential store failed:", message);
      response.status(500).json({ error: "Failed to store the credential" });
    }
  });

  /** Activate or deactivate a credential. Deactivating is how an employer's authorization is withdrawn, so it is audited. */
  app.post("/api/admin/ats-credentials/:id/active", requireAuth, requireAdmin, async (request: AuthenticatedRequest, response) => {
    const id = request.params.id as string;
    const body = (request.body ?? {}) as Record<string, unknown>;

    if (!UUID_PATTERN.test(id)) {
      response.status(400).json({ error: "id must be a uuid" });
      return;
    }

    if (typeof body.isActive !== "boolean") {
      response.status(400).json({ error: "isActive must be a boolean" });
      return;
    }

    try {
      const client = resolveServiceClient();
      await setAtsCredentialActive(client, id, body.isActive);

      await recordAuditEvent(client, {
        actorId: request.user!.id,
        actorRole: "admin",
        action: body.isActive ? "ats_credential.activated" : "ats_credential.deactivated",
        entityType: "ats_credential",
        entityId: id,
        summary: (body.isActive ? "Activated" : "Deactivated") + " an ATS credential",
        previousValues: { isActive: !body.isActive },
        newValues: { isActive: body.isActive },
      });

      // The trigger on ats_credentials has already re-derived the source policy
      // by now, so the caller is told the consequence rather than having to
      // re-read the source list to discover it.
      response.status(200).json({
        id,
        isActive: body.isActive,
        note: body.isActive
          ? "Automated application is now enabled for this source."
          : "Automated application is now disabled for this source.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("ATS credential activation failed:", message);
      response.status(500).json({ error: "Failed to update the credential" });
    }
  });

  // Mini-Phase 8: the local fixture submission target that the
  // local_fixture adapter drives. Mounted everywhere except production, and
  // switchable off entirely with DISABLE_MOCK_EMPLOYER=true — see
  // server/mockEmployer.ts for why this exists and what it does (nothing).
  if (isMockEmployerEnabled()) {
    mountMockEmployer(app);
  }

  const clientBuildPath = options.clientBuildPath ?? path.resolve(process.cwd(), "dist/client");

  if (existsSync(clientBuildPath)) {
    app.use(express.static(clientBuildPath));

    // SPA fallback: any unmatched GET that is not under /api serves the app
    // shell, so a deep link like /resumes renders the client instead of
    // Express's "Cannot GET /resumes" error page.
    //
    // A RegExp, NOT app.get("*"). Express 5 (path-to-regexp v8) removed the
    // bare "*" path and throws "Missing parameter name at index 1: *" while the
    // route is being registered — that is at startup, so it would crash the
    // server on boot rather than 404 one page.
    //
    // The negative lookahead is deliberate: an unknown /api/* path must still
    // answer 404, not index.html. Handing HTML to a JSON client turns a clean
    // not-found into an unparseable response body. Registered after every API
    // route, so it can only ever see paths nothing else claimed.
    app.get(/^(?!\/api\/).*/, (_request, response) => {
      response.sendFile(path.join(clientBuildPath, "index.html"));
    });
  }

  return app;
}

const port = Number.parseInt(process.env.PORT ?? "5000", 10);
const host = process.env.HOST ?? "127.0.0.1";

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const app = createApp();

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  app.listen(port, host, () => {
    console.log(`${APP_NAME} server listening at http://${host}:${port}`);

    if (isMockEmployerEnabled()) {
      console.log(
        `[mock-employer] fixture submission target mounted at http://${host}:${port}/mock-employer/apply — development only, submits nowhere.`,
      );
    }
  });
}

export { app };
