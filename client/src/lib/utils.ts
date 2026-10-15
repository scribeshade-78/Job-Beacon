import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * The focus treatment for CUSTOM inline controls — text buttons, filter pills, option
 * rows — that are not the Button primitive.
 *
 * WHY IT IS EXPLICIT RATHER THAN INHERITED. The app's baseline is the global
 * :focus-visible outline in styles.css, and the Button primitive relies on it. A custom
 * control with its own radius or a tight hit area makes that baseline read
 * inconsistently, so the sibling precedent (JobDetailPage's inline links) draws a token
 * ring instead. outline-none suppresses the baseline so the two indicators can never
 * appear at once. A ring follows the element's own border-radius, so pills stay pills.
 */
export const INLINE_FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue";
