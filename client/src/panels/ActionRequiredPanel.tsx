import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { buttonVariants } from "../components/ui/button";
import {
  listActionRequiredEvents,
  type ActionRequiredEvent,
  type ActionRequiredExceptionType,
} from "../lib/actionRequired";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";
import { safeVacancyHref } from "./shared";

const ACTION_REQUIRED_LABELS: Record<ActionRequiredExceptionType, string> = {
  captcha: "CAPTCHA to solve",
  otp_or_email_code: "One-time code needed",
  unknown_sensitive_question: "Unrecognized or sensitive question",
  missing_verified_fact: "Missing verified information",
  external_assessment: "External assessment or interview",
  unsupported_portal: "Unsupported application portal",
  payment_or_financial_request: "Payment or financial information requested",
};

export function ActionRequiredPanel() {
  const [events, setEvents] = useState<ActionRequiredEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listActionRequiredEvents(getSupabaseBrowserClient()).then((result) => {
      if (result.kind === "success") {
        setEvents(result.events);
      } else {
        setError(result.message);
      }
    });
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle id="action-required-title">Action Required</CardTitle>
      </CardHeader>
      <CardContent aria-labelledby="action-required-title">
        {error && (
          <p role="alert" className="text-sm text-status-blocked-fg">
            {error}
          </p>
        )}
        {events?.length === 0 && (
          <p className="text-sm text-ios-text-secondary">Nothing needs your attention right now.</p>
        )}
        <ul className="space-y-3">
          {events?.map((event) => (
            <li
              key={event.id}
              className="flex flex-col gap-2 rounded-control border border-ios-separator p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="font-medium text-black">{event.vacancyTitle}</p>
                <p className="text-sm text-ios-text-secondary">
                  {ACTION_REQUIRED_LABELS[event.exceptionType]}
                  {event.expiresAt && ` (expires ${event.expiresAt})`}
                </p>
              </div>
              <a
                href={safeVacancyHref(event.vacancyUrl)}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants("primary", "sm")}
              >
                View details
              </a>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
