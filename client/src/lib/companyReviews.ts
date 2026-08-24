import type { SupabaseClient } from "@supabase/supabase-js";

export interface ReviewableCompany {
  id: string;
  displayedName: string;
}

const GENERIC_LIST_COMPANIES_FAILURE_MESSAGE = "Could not load companies. Please try again.";

export type ListCompaniesForReviewResult =
  | { kind: "success"; companies: ReviewableCompany[] }
  | { kind: "error"; message: string };

/**
 * Any company in the system is reviewable, not only ones with a verified
 * company_profiles row (companyIntelligence.ts's listVerifiedCompanies is
 * narrower, for the verified-facts display specifically) — a candidate's
 * lived experience isn't gated on that separate verification pipeline.
 */
export async function listCompaniesForReview(
  client: Pick<SupabaseClient, "from">,
): Promise<ListCompaniesForReviewResult> {
  try {
    const { data, error } = await client
      .from("companies")
      .select("id, displayed_name")
      .order("displayed_name", { ascending: true });

    if (error || !data) {
      return { kind: "error", message: GENERIC_LIST_COMPANIES_FAILURE_MESSAGE };
    }

    return {
      kind: "success",
      companies: data.map((row) => ({ id: row.id, displayedName: row.displayed_name })),
    };
  } catch {
    return { kind: "error", message: GENERIC_LIST_COMPANIES_FAILURE_MESSAGE };
  }
}

export interface ReviewRatings {
  workLifeBalance: number;
  compensation: number;
  managementAndCulture: number;
  careerGrowth: number;
}

const GENERIC_SUBMIT_FAILURE_MESSAGE = "Could not submit your review. Please try again.";
const POSTGRES_UNIQUE_VIOLATION = "23505";

export type SubmitReviewResult = { kind: "success" } | { kind: "duplicate" } | { kind: "error"; message: string };

/**
 * Inserts the candidate's own row (company_reviews_insert_own RLS). Unlike
 * selectRole/authorize's "23505 = idempotent success" pattern elsewhere in
 * this codebase, a duplicate review submission is NOT idempotent — the
 * candidate's new ratings/text would be silently discarded while the old
 * row stays, so reporting plain success would be misleading. Surfaced as
 * its own "duplicate" kind instead.
 */
export async function submitCompanyReview(
  client: Pick<SupabaseClient, "from">,
  companyId: string,
  reviewerId: string,
  ratings: ReviewRatings,
  reviewText: string | null,
): Promise<SubmitReviewResult> {
  try {
    const { error } = await client.from("company_reviews").insert({
      company_id: companyId,
      reviewer_id: reviewerId,
      work_life_balance: ratings.workLifeBalance,
      compensation: ratings.compensation,
      management_and_culture: ratings.managementAndCulture,
      career_growth: ratings.careerGrowth,
      review_text: reviewText,
    });

    if (error) {
      if (error.code === POSTGRES_UNIQUE_VIOLATION) {
        return { kind: "duplicate" };
      }
      return { kind: "error", message: GENERIC_SUBMIT_FAILURE_MESSAGE };
    }

    return { kind: "success" };
  } catch {
    return { kind: "error", message: GENERIC_SUBMIT_FAILURE_MESSAGE };
  }
}

/** PRD §14.4's four review-count bands. */
export type PublicationTier = "insufficient" | "low_confidence" | "confident" | "prominent";

export interface ReviewAverages {
  workLifeBalance: number;
  compensation: number;
  managementAndCulture: number;
  careerGrowth: number;
}

export interface CompanyReviewSummary {
  reviewCount: number;
  tier: PublicationTier;
  /** null only for the "insufficient" tier — PRD §14.4: "no score" below 5 reviews, not a low/zero score. */
  averages: ReviewAverages | null;
}

const GENERIC_SUMMARY_FAILURE_MESSAGE = "Could not load company reviews. Please try again.";

export type GetCompanyReviewSummaryResult =
  | { kind: "success"; summary: CompanyReviewSummary }
  | { kind: "error"; message: string };

function tierForCount(count: number): PublicationTier {
  if (count < 5) return "insufficient";
  if (count < 10) return "low_confidence";
  if (count < 20) return "confident";
  return "prominent";
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Reads company_reviews_public (never the base company_reviews table for
 * this — that would defeat the anonymity boundary the view exists to
 * enforce) and computes the §14.4 tier/averages client-side; no DB
 * aggregation function exists for this yet. The "prominent" tier (20+)
 * only gets averages here, same as "confident" — §14.4 also calls for a
 * distribution and trend at that tier, neither of which is computed by
 * this function; that's a real gap in this pass, not silently dropped.
 */
export async function getCompanyReviewSummary(
  client: Pick<SupabaseClient, "from">,
  companyId: string,
): Promise<GetCompanyReviewSummaryResult> {
  try {
    const { data, error } = await client
      .from("company_reviews_public")
      .select("work_life_balance, compensation, management_and_culture, career_growth")
      .eq("company_id", companyId);

    if (error || !data) {
      return { kind: "error", message: GENERIC_SUMMARY_FAILURE_MESSAGE };
    }

    const reviewCount = data.length;
    const tier = tierForCount(reviewCount);

    return {
      kind: "success",
      summary: {
        reviewCount,
        tier,
        averages:
          tier === "insufficient"
            ? null
            : {
                workLifeBalance: average(data.map((row) => row.work_life_balance)),
                compensation: average(data.map((row) => row.compensation)),
                managementAndCulture: average(data.map((row) => row.management_and_culture)),
                careerGrowth: average(data.map((row) => row.career_growth)),
              },
      },
    };
  } catch {
    return { kind: "error", message: GENERIC_SUMMARY_FAILURE_MESSAGE };
  }
}
