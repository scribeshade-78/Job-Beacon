export const APP_NAME = "JobBeacon";
export const HEALTH_PATH = "/api/health";

export interface HealthResponse {
  status: "ok";
  service: typeof APP_NAME;
}

