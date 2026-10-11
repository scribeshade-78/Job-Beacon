export const APP_NAME = "JobBeacon";
export const HEALTH_PATH = "/api/health";

/**
 * One key's state, as reported by /api/health.
 *
 * NAME AND BOOLEAN ONLY. /api/health is unauthenticated and publicly routed, so
 * this type must never grow a value, a length or a prefix - the whole point is to
 * assert the environment without handing a secret to anyone who asks.
 */
export interface HealthEnvKey {
  name: string;
  required: boolean;
  present: boolean;
  /** What stops working without it. */
  consequence: string;
}

/**
 * Brief 3 - the health payload answers "what is actually running, with what config,
 * and can it reach its dependencies", which previously required shelling into the
 * host to find out.
 *
 * `status` STAYS THE LITERAL "ok" EVEN WHEN `environment.ok` IS FALSE, and that is
 * deliberate: liveness and configuration-validity are different questions. This
 * endpoint is the Dockerfile HEALTHCHECK and Traefik's probe, so failing it would
 * pull the container out of rotation. The verdict lives in the body, where
 * deploy/assert-environment.sh reads it and fails the rollout instead.
 */
export interface HealthResponse {
  status: "ok";
  service: typeof APP_NAME;
  /** The artefact identity: what was built, when it was built, and when it was deployed. */
  version: {
    commit: string;
    builtAt: string;
    deployedAt: string;
  };
  environment: {
    ok: boolean;
    requiredMissing: string[];
    optionalMissing: string[];
    keys: HealthEnvKey[];
  };
  dependencies: {
    /** A real round trip, not a config read: a present-but-invalid key must not read as ok. */
    supabase: "ok" | "failed";
  };
}
