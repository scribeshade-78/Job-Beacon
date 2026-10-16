/**
 * The six §11.2 technical-fit dimensions, in the order a candidate should read them.
 *
 * WHY THIS LIVES IN shared/ RATHER THAN IN THE PROMPT. The server scores these six and the
 * client renders them, and until now the only list was in server/opportunities/fitPrompt.ts —
 * which the client cannot import. A second copy there would have been a copy that drifts, and
 * the failure is silent in the direction that matters: a dimension the client does not know
 * about is one the candidate is never shown.
 *
 * Order is a contract here, not a preference: the components arrive as a jsonb object, and
 * jsonb does not preserve key order, so the display order has to come from a list.
 */
export const FIT_DIMENSIONS = [
  "core_technical_skills",
  "cloud_alignment",
  "engineering_responsibilities",
  "scale_performance_evidence",
  "seniority",
  "domain",
] as const;

export type FitDimension = (typeof FIT_DIMENSIONS)[number];
