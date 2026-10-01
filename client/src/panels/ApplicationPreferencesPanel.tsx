import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Label } from "../components/ui/label";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import { Switch } from "../components/ui/switch";
import {
  DEFAULT_APPLICATION_PREFERENCES,
  loadApplicationPreferences,
  RESUME_OPTIMIZATION_LEVELS,
  updateResumeOptimizationLevel,
  updateReviewBeforeSubmit,
  type ApplicationPreferences,
  type ResumeOptimizationLevel,
} from "../lib/applicationPreferences";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

/**
 * Copy is provisional. The three level names are product-given; the one-line
 * descriptions below are written to be strictly weaker than the names
 * themselves (they describe the direction, not a specific algorithm) because
 * no document in this repo defines what "aggressive" actually rewrites. They
 * need a product pass before this ships to candidates.
 */
const RESUME_OPTIMIZATION_LABELS: Record<ResumeOptimizationLevel, string> = {
  off: "Off",
  honest: "Honest",
  aggressive: "Aggressive",
};

const RESUME_OPTIMIZATION_DESCRIPTIONS: Record<ResumeOptimizationLevel, string> = {
  off: "Your resume is used as uploaded, with no rewriting.",
  honest: "Wording is tailored to each role; your facts are not changed.",
  aggressive: "Content is reordered and reworded as strongly as your facts allow.",
};

const CONSENT_NOTE =
  "Auto-approve only executes if you have provided explicit Automation Consent on the Home page.";

interface ApplicationPreferencesPanelProps {
  candidateId: string;
}

export function ApplicationPreferencesPanel({ candidateId }: ApplicationPreferencesPanelProps) {
  const [preferences, setPreferences] = useState<ApplicationPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadApplicationPreferences(getSupabaseBrowserClient(), candidateId).then((result) => {
      if (result.kind === "success") {
        setPreferences(result.preferences);
      } else {
        setError(result.message);
      }
    });
  }, [candidateId]);

  /**
   * No optimistic update, matching ExclusionsPanel: the control stays on its
   * stored value until the write is confirmed. A radio that snaps back on
   * failure is the honest signal that nothing was saved; one that stays put
   * would show a preference the database does not hold — which for this
   * particular setting is the difference between "we will not submit without
   * you" and a silent promise the app cannot keep.
   */
  async function handleLevelChange(level: ResumeOptimizationLevel) {
    if (preferences === null || level === preferences.resumeOptimizationLevel) {
      return;
    }

    setError(null);
    setSaving(true);

    const result = await updateResumeOptimizationLevel(getSupabaseBrowserClient(), candidateId, level);

    setSaving(false);

    if (result.kind === "error") {
      setError(result.message);
      return;
    }

    setPreferences((previous) => ({
      ...(previous ?? DEFAULT_APPLICATION_PREFERENCES),
      resumeOptimizationLevel: level,
    }));
  }

  async function handleReviewBeforeSubmitChange(reviewBeforeSubmit: boolean) {
    if (preferences === null || reviewBeforeSubmit === preferences.reviewBeforeSubmit) {
      return;
    }

    setError(null);
    setSaving(true);

    const result = await updateReviewBeforeSubmit(getSupabaseBrowserClient(), candidateId, reviewBeforeSubmit);

    setSaving(false);

    if (result.kind === "error") {
      setError(result.message);
      return;
    }

    setPreferences((previous) => ({
      ...(previous ?? DEFAULT_APPLICATION_PREFERENCES),
      reviewBeforeSubmit,
    }));
  }

  const disabled = saving || preferences === null;

  return (
    <Card>
      <CardHeader>
        <CardTitle id="application-preferences-title">Application Preferences</CardTitle>
      </CardHeader>
      <CardContent aria-labelledby="application-preferences-title" className="space-y-6">
        {error && (
          <p role="alert" className="text-sm text-status-blocked-fg">
            {error}
          </p>
        )}

        <div className="space-y-3">
          <div className="space-y-0.5">
            <h3 id="resume-optimization-heading" className="text-sm font-medium text-black">
              Resume Optimization
            </h3>
            <p className="text-xs text-ios-text-secondary">
              How much your generated resume may be adjusted for a role.
            </p>
          </div>

          <RadioGroup
            aria-labelledby="resume-optimization-heading"
            value={preferences?.resumeOptimizationLevel ?? ""}
            onValueChange={(value) => void handleLevelChange(value as ResumeOptimizationLevel)}
            disabled={disabled}
          >
            {RESUME_OPTIMIZATION_LEVELS.map((level) => (
              <div key={level} className="flex items-start gap-2.5">
                <RadioGroupItem
                  value={level}
                  id={`resume-optimization-${level}`}
                  className="mt-0.5"
                  disabled={disabled}
                />
                <div className="space-y-0.5">
                  <Label htmlFor={`resume-optimization-${level}`} className="font-normal">
                    {RESUME_OPTIMIZATION_LABELS[level]}
                  </Label>
                  <p className="text-xs text-ios-text-secondary">{RESUME_OPTIMIZATION_DESCRIPTIONS[level]}</p>
                </div>
              </div>
            ))}
          </RadioGroup>
        </div>

        <div className="space-y-2 border-t border-ios-separator pt-5">
          <h3 className="text-sm font-medium text-black">Execution Workflow</h3>

          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
              {/* A <label for> works here because Radix renders the switch as
                  a <button>, and button is a labelable element. */}
              <Label htmlFor="review-before-submit">Review before submit</Label>
              <p className="text-xs text-ios-text-secondary">
                {preferences === null
                  ? "Loading…"
                  : preferences.reviewBeforeSubmit
                    ? "On — you review each application before it is submitted."
                    : "Off — applications may be submitted for you without a review step."}
              </p>
            </div>
            <Switch
              id="review-before-submit"
              checked={preferences?.reviewBeforeSubmit ?? DEFAULT_APPLICATION_PREFERENCES.reviewBeforeSubmit}
              onCheckedChange={(checked) => void handleReviewBeforeSubmitChange(checked)}
              disabled={disabled}
            />
          </div>

          <p className="text-xs text-ios-text-secondary">{CONSENT_NOTE}</p>
        </div>
      </CardContent>
    </Card>
  );
}
