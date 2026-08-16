import { createHash } from "node:crypto";
import type { DiscoveredVacancy } from "./types.js";

export function computeContentHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function isoWeekLabel(isoDateString: string): string {
  const date = new Date(isoDateString);

  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  // ISO week number (Thursday-anchored week-of-year), a standard algorithm —
  // not invented. Used only to bucket "same publish window" for the dedup
  // rule 3 fingerprint (PRD §11.3), not for anything date-display-facing.
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week =
    1 + Math.round(((target.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);

  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Dedup rule 3 (§11.3): "Company + normalized title + location +
 * publish-window fingerprint". "Location" here is country only — city/
 * region aren't populated by any adapter (see each adapter's comments on
 * why), so including them would make every fingerprint trivially unique
 * and defeat the purpose.
 */
export function computeFingerprint(vacancy: DiscoveredVacancy): string {
  const parts = [
    vacancy.companyName.trim().toLowerCase(),
    vacancy.rawTitle.trim().toLowerCase().replace(/\s+/g, " "),
    (vacancy.country ?? "").trim().toLowerCase(),
    vacancy.publishedAt ? isoWeekLabel(vacancy.publishedAt) : "unknown",
  ];

  return createHash("sha256").update(parts.join("|")).digest("hex");
}
