import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import {
  getCompanyReviewSummary,
  listCompaniesForReview,
  submitCompanyReview,
  type CompanyReviewSummary,
  type ReviewableCompany,
  type ReviewRatings,
} from "../lib/companyReviews";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

interface CompanyReviewsPanelProps {
  candidateId: string;
}

const DIMENSION_LABELS: Record<keyof ReviewRatings, string> = {
  workLifeBalance: "Work-life balance",
  compensation: "Compensation & benefits",
  managementAndCulture: "Management & culture",
  careerGrowth: "Career growth",
};

const DEFAULT_RATINGS: ReviewRatings = {
  workLifeBalance: 3,
  compensation: 3,
  managementAndCulture: 3,
  careerGrowth: 3,
};

function StarRatingInput({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-black">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex gap-1">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={value === star}
            aria-label={`${star} star${star === 1 ? "" : "s"}`}
            disabled={disabled}
            onClick={() => onChange(star)}
            className="disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Star
              className={`h-5 w-5 ${star <= value ? "fill-ios-blue text-ios-blue" : "text-ios-separator"}`}
              aria-hidden="true"
            />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * PRD §14.4's rating publication thresholds — same numbers the tier itself
 * is computed from in companyReviews.ts, just the display copy for each.
 */
const TIER_COPY: Record<CompanyReviewSummary["tier"], string> = {
  insufficient: "Insufficient verified responses.",
  low_confidence: "Directional score (low confidence — fewer than 10 verified reviews).",
  confident: "Score based on verified reviews.",
  prominent: "Score based on a large sample of verified reviews.",
};

function SummaryDisplay({ summary }: { summary: CompanyReviewSummary }) {
  return (
    <div className="rounded-control bg-ios-bg p-3 text-sm">
      <p className="text-ios-text-secondary">
        {summary.reviewCount} verified review{summary.reviewCount === 1 ? "" : "s"} · {TIER_COPY[summary.tier]}
      </p>
      {summary.averages && (
        <ul className="mt-2 space-y-1">
          {(Object.keys(DIMENSION_LABELS) as Array<keyof ReviewRatings>).map((key) => (
            <li key={key} className="flex justify-between text-black">
              <span>{DIMENSION_LABELS[key]}</span>
              <span>{summary.averages![key].toFixed(1)} / 5</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CompanyReviewsPanel({ candidateId }: CompanyReviewsPanelProps) {
  const [companies, setCompanies] = useState<ReviewableCompany[] | null>(null);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [summary, setSummary] = useState<CompanyReviewSummary | null>(null);
  const [ratings, setRatings] = useState<ReviewRatings>(DEFAULT_RATINGS);
  const [reviewText, setReviewText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    listCompaniesForReview(getSupabaseBrowserClient()).then((result) => {
      if (result.kind === "success") {
        setCompanies(result.companies);
      } else {
        setError(result.message);
      }
    });
  }, []);

  useEffect(() => {
    if (!selectedCompanyId) {
      setSummary(null);
      return;
    }

    let cancelled = false;
    getCompanyReviewSummary(getSupabaseBrowserClient(), selectedCompanyId).then((result) => {
      if (cancelled) return;
      if (result.kind === "success") {
        setSummary(result.summary);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [selectedCompanyId]);

  async function handleSubmit() {
    if (!selectedCompanyId) {
      return;
    }

    setBusy(true);
    setError(null);
    setSubmitted(false);

    const result = await submitCompanyReview(
      getSupabaseBrowserClient(),
      selectedCompanyId,
      candidateId,
      ratings,
      reviewText.trim() === "" ? null : reviewText.trim(),
    );

    if (result.kind === "duplicate") {
      setError("You've already reviewed this company.");
    } else if (result.kind === "error") {
      setError(result.message);
    } else {
      setSubmitted(true);
      setRatings(DEFAULT_RATINGS);
      setReviewText("");
    }

    setBusy(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle id="company-reviews-title">Company Reviews</CardTitle>
      </CardHeader>
      <CardContent aria-labelledby="company-reviews-title" className="space-y-4">
        {error && (
          <p role="alert" className="text-sm text-status-blocked-fg">
            {error}
          </p>
        )}
        {submitted && (
          <p role="status" className="text-sm text-status-verified-fg">
            Review submitted — pending verification before it's shown publicly.
          </p>
        )}

        <div>
          <label htmlFor="review-company" className="text-sm font-medium text-black">
            Company
          </label>
          <select
            id="review-company"
            value={selectedCompanyId}
            onChange={(event) => setSelectedCompanyId(event.target.value)}
            disabled={busy}
            className="mt-1 h-11 w-full rounded-control border border-ios-separator bg-ios-card px-3.5 text-[15px] text-black disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="">Select a company…</option>
            {companies?.map((company) => (
              <option key={company.id} value={company.id}>
                {company.displayedName}
              </option>
            ))}
          </select>
        </div>

        {selectedCompanyId && (
          <>
            {summary && <SummaryDisplay summary={summary} />}

            <div className="space-y-2">
              {(Object.keys(DIMENSION_LABELS) as Array<keyof ReviewRatings>).map((key) => (
                <StarRatingInput
                  key={key}
                  label={DIMENSION_LABELS[key]}
                  value={ratings[key]}
                  disabled={busy}
                  onChange={(next) => setRatings((current) => ({ ...current, [key]: next }))}
                />
              ))}
            </div>

            <div>
              <label htmlFor="review-text" className="text-sm font-medium text-black">
                Review (optional)
              </label>
              <textarea
                id="review-text"
                value={reviewText}
                onChange={(event) => setReviewText(event.target.value)}
                disabled={busy}
                rows={3}
                className="mt-1 w-full rounded-control border border-ios-separator bg-ios-card px-3.5 py-2.5 text-[15px] text-black placeholder:text-ios-text-secondary focus-visible:border-ios-blue disabled:cursor-not-allowed disabled:opacity-50"
                placeholder="Shown anonymously once verified — never with your name."
              />
            </div>

            <Button disabled={busy} onClick={() => void handleSubmit()}>
              {busy ? "Submitting…" : "Submit review"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
