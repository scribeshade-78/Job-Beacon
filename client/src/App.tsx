import { useEffect, useState, type ChangeEvent } from "react";
import { APP_NAME } from "../../shared/app";
import { AuthCard } from "./components/AuthCard";
import { ConfirmationPendingScreen } from "./components/ConfirmationPendingScreen";
import { LoadingScreen } from "./components/LoadingScreen";
import {
  listActionRequiredEvents,
  type ActionRequiredEvent,
  type ActionRequiredExceptionType,
} from "./lib/actionRequired";
import { listApplications, type ApplicationSummary } from "./lib/applications";
import {
  listSalaryBenchmarks,
  listVerifiedCompanies,
  type CompanyIntelligenceEntry,
  type SalaryBenchmarkEntry,
} from "./lib/companyIntelligence";
import {
  authorize,
  CONSENT_DISCLOSURE,
  getAuthorization,
  pause,
  resume as resumeAutomation,
  stop,
  type Authorization,
} from "./lib/automationAuthorization";
import { fetchVerifiedIdentity, useAuth, type AuthUser } from "./lib/auth";
import {
  EXCLUSION_CATEGORIES,
  listExclusions,
  setExclusion,
  type ExclusionCategory,
} from "./lib/exclusions";
import {
  enrollTotp,
  listTotpFactors,
  unenrollFactor,
  verifyEnrollment,
  type TotpEnrollment,
  type TotpFactorSummary,
} from "./lib/mfa";
import { listMailboxConnections, type MailboxConnection } from "./lib/mailbox";
import { listMessages, type MailboxMessage } from "./lib/mailboxMessages";
import { ensureCandidateProfile } from "./lib/profile";
import { deleteResume, getResumeSignedUrl, listResumes, uploadResume, type ResumeDocument } from "./lib/resume";
import { revokeOtherSessions } from "./lib/session";
import { getSupabaseBrowserClient } from "./lib/supabaseClient";

export function App() {
  const auth = useAuth();
  const [identity, setIdentity] = useState<AuthUser | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  // candidate_profiles is the FK target for resume_documents,
  // candidate_exclusions, and automation_authorizations — panels backed by
  // those tables must not render (and let the candidate attempt an insert)
  // until this resolves, or a fast interaction on a slow connection hits a
  // foreign-key violation before the row exists.
  const [profileReady, setProfileReady] = useState(false);

  useEffect(() => {
    if (auth.status !== "signedIn" || !auth.user) {
      setProfileError(null);
      setProfileReady(false);
      return;
    }

    let cancelled = false;
    setProfileError(null);
    setProfileReady(false);

    ensureCandidateProfile(getSupabaseBrowserClient(), auth.user.id).then((result) => {
      if (cancelled) {
        return;
      }

      if (result.kind === "error") {
        setProfileError(result.message);
      } else {
        setProfileReady(true);
      }
    });

    return () => {
      cancelled = true;
    };
    // Deliberately depends on auth.status only. TOKEN_REFRESHED keeps status
    // "signedIn" but issues a new session/access_token object — this must
    // run once per sign-in, not on every refresh. Widening this array
    // reintroduces a redundant insert attempt on every token refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status]);

  useEffect(() => {
    if (auth.status !== "signedIn" || !auth.session) {
      setIdentity(null);
      setIdentityError(null);
      return;
    }

    let cancelled = false;

    fetchVerifiedIdentity(getSupabaseBrowserClient(), auth.session.access_token).then((result) => {
      if (cancelled) {
        return;
      }

      if (result.kind === "success") {
        setIdentity(result.user);
        setIdentityError(null);
      } else if (result.kind === "unauthenticated") {
        void auth.signOut();
      } else {
        setIdentityError(result.message);
      }
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status, auth.session?.access_token]);

  if (auth.status === "loading") {
    return <LoadingScreen />;
  }

  if (auth.status === "confirmationPending") {
    return <ConfirmationPendingScreen />;
  }

  if (auth.status === "signedIn") {
    return (
      <main className="app-shell">
        <section aria-labelledby="app-title" className="foundation-card">
          <h1 id="app-title">{APP_NAME}</h1>
          {identityError && <p role="alert">{identityError}</p>}
          {profileError && <p role="alert">{profileError}</p>}
          {identity && <p>Signed in as {identity.email ?? identity.id}</p>}
          <button type="button" onClick={() => void auth.signOut()}>
            Log out
          </button>
        </section>

        {auth.user && profileReady && (
          <>
            <ApplicationsPanel />
            <ActionRequiredPanel />
            <MailboxPanel />
            <MessagesPanel />
            <ResumesPanel candidateId={auth.user.id} />
            <ExclusionsPanel candidateId={auth.user.id} />
            <AutomationPanel candidateId={auth.user.id} />
          </>
        )}
        {/* companies/company_profiles/company_legal_entities/salary_benchmarks
            are public-within-the-app reference data with no FK to
            candidate_profiles, so — like SecurityPanel — these don't need
            to wait on profileReady either. */}
        {auth.user && (
          <>
            <SecurityPanel />
            <CompaniesPanel />
            <SalaryBenchmarksPanel />
          </>
        )}
      </main>
    );
  }

  return <AuthCard onSignUp={auth.signUp} onSignIn={auth.signIn} error={auth.status === "error" ? auth.error : null} />;
}

const EXCLUSION_LABELS: Record<ExclusionCategory, string> = {
  staffing_agencies: "Staffing agencies",
  contract_roles: "Contract roles",
  relocation_required: "Roles requiring relocation",
  sensitive_sectors: "Sensitive sectors",
};

/**
 * authoritative_url has no scheme constraint at the DB level and is
 * populated from external, scraped job sources — rendering it into an
 * href unchecked would let a malicious source-side value (e.g. a
 * javascript: URL) execute on click. http(s)-only allowlist, same
 * discipline as resume.ts's isSupportedMimeType.
 */
function safeVacancyHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : "#";
}

const ACTION_REQUIRED_LABELS: Record<ActionRequiredExceptionType, string> = {
  captcha: "CAPTCHA to solve",
  otp_or_email_code: "One-time code needed",
  unknown_sensitive_question: "Unrecognized or sensitive question",
  missing_verified_fact: "Missing verified information",
  external_assessment: "External assessment or interview",
  unsupported_portal: "Unsupported application portal",
  payment_or_financial_request: "Payment or financial information requested",
};

function ApplicationsPanel() {
  const [applications, setApplications] = useState<ApplicationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listApplications(getSupabaseBrowserClient()).then((result) => {
      if (result.kind === "success") {
        setApplications(result.applications);
      } else {
        setError(result.message);
      }
    });
  }, []);

  return (
    <section aria-labelledby="applications-title" className="foundation-card">
      <h2 id="applications-title">Applications</h2>
      {error && <p role="alert">{error}</p>}
      {applications?.length === 0 && <p>No applications yet.</p>}
      <ul>
        {applications?.map((application) => (
          <li key={application.planId}>
            <a href={safeVacancyHref(application.vacancyUrl)} target="_blank" rel="noopener noreferrer">
              {application.vacancyTitle}
            </a>{" "}
            — {application.eligible ? "eligible" : "not eligible"}
            {application.attempts.length > 0 && (
              <ul>
                {application.attempts.map((attempt) => (
                  <li key={attempt.id}>
                    {attempt.status}
                    {attempt.lastError && `: ${attempt.lastError}`}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ActionRequiredPanel() {
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
    <section aria-labelledby="action-required-title" className="foundation-card">
      <h2 id="action-required-title">Action Required</h2>
      {error && <p role="alert">{error}</p>}
      {events?.length === 0 && <p>Nothing needs your attention right now.</p>}
      <ul>
        {events?.map((event) => (
          <li key={event.id}>
            <a href={safeVacancyHref(event.vacancyUrl)} target="_blank" rel="noopener noreferrer">
              {event.vacancyTitle}
            </a>{" "}
            — {ACTION_REQUIRED_LABELS[event.exceptionType]}
            {event.expiresAt && ` (expires ${event.expiresAt})`}
          </li>
        ))}
      </ul>
    </section>
  );
}

const MAILBOX_PROVIDER_LABELS: Record<MailboxConnection["provider"], string> = {
  gmail: "Gmail",
  outlook: "Outlook",
};

function MailboxPanel() {
  const [connections, setConnections] = useState<MailboxConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listMailboxConnections(getSupabaseBrowserClient()).then((result) => {
      if (result.kind === "success") {
        setConnections(result.connections);
      } else {
        setError(result.message);
      }
    });
  }, []);

  return (
    <section aria-labelledby="mailbox-title" className="foundation-card">
      <h2 id="mailbox-title">Mailbox</h2>
      {error && <p role="alert">{error}</p>}
      {connections?.length === 0 && <p>No mailbox connected yet.</p>}
      <ul>
        {connections?.map((connection) => (
          <li key={connection.id}>
            {MAILBOX_PROVIDER_LABELS[connection.provider]} — {connection.status}
            {connection.connectedAt && ` (connected ${connection.connectedAt})`}
            {connection.revokedAt && ` (revoked ${connection.revokedAt})`}
          </li>
        ))}
      </ul>
    </section>
  );
}

function MessagesPanel() {
  const [messages, setMessages] = useState<MailboxMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listMessages(getSupabaseBrowserClient()).then((result) => {
      if (result.kind === "success") {
        setMessages(result.messages);
      } else {
        setError(result.message);
      }
    });
  }, []);

  return (
    <section aria-labelledby="messages-title" className="foundation-card">
      <h2 id="messages-title">Messages</h2>
      {error && <p role="alert">{error}</p>}
      {messages?.length === 0 && <p>No messages yet.</p>}
      <ul>
        {messages?.map((message) => (
          <li key={message.id}>
            {message.subject ?? "(no subject)"}
            {message.sender && ` — ${message.sender}`}
            {message.receivedAt && ` (${message.receivedAt})`}
            {(message.classifications.length > 0 || message.interviews.length > 0 || message.actionItems.length > 0) && (
              <ul>
                {message.classifications.map((classification) => (
                  <li key={classification.id}>Classified: {classification.category}</li>
                ))}
                {message.interviews.map((interview) => (
                  <li key={interview.id}>
                    Interview{interview.format && ` (${interview.format})`}
                    {interview.scheduledAt && ` — ${interview.scheduledAt}`}
                  </li>
                ))}
                {message.actionItems.map((item) => (
                  <li key={item.id}>
                    Action needed: {item.itemType} — {item.status}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

interface ResumesPanelProps {
  candidateId: string;
}

function ResumesPanel({ candidateId }: ResumesPanelProps) {
  const [resumes, setResumes] = useState<ResumeDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const result = await listResumes(getSupabaseBrowserClient());

    if (result.kind === "success") {
      setResumes(result.resumes);
    } else {
      setError(result.message);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    setBusy(true);
    setError(null);

    const result = await uploadResume(
      getSupabaseBrowserClient(),
      candidateId,
      { name: file.name, type: file.type, size: file.size },
      file,
    );

    if (result.kind === "error") {
      setError(result.message);
    } else {
      await refresh();
    }

    setBusy(false);
  }

  async function handleView(storagePath: string) {
    const result = await getResumeSignedUrl(getSupabaseBrowserClient(), storagePath);

    if (result.kind === "error") {
      setError(result.message);
      return;
    }

    window.open(result.url, "_blank", "noopener,noreferrer");
  }

  async function handleDelete(id: string, storagePath: string) {
    setBusy(true);
    const result = await deleteResume(getSupabaseBrowserClient(), id, storagePath);

    if (result.kind === "error") {
      setError(result.message);
    } else {
      await refresh();
    }

    setBusy(false);
  }

  return (
    <section aria-labelledby="resumes-title" className="foundation-card">
      <h2 id="resumes-title">Resumes</h2>
      {error && <p role="alert">{error}</p>}
      <input
        type="file"
        accept="application/pdf,.pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        disabled={busy}
        onChange={(event) => void handleFileChange(event)}
        aria-label="Upload resume"
      />
      <ul>
        {resumes?.map((resume) => (
          <li key={resume.id}>
            {resume.originalFilename}{" "}
            <button type="button" disabled={busy} onClick={() => void handleView(resume.storagePath)}>
              View
            </button>
            <button type="button" disabled={busy} onClick={() => void handleDelete(resume.id, resume.storagePath)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface ExclusionsPanelProps {
  candidateId: string;
}

function ExclusionsPanel({ candidateId }: ExclusionsPanelProps) {
  const [active, setActive] = useState<Set<ExclusionCategory> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listExclusions(getSupabaseBrowserClient()).then((result) => {
      if (result.kind === "success") {
        setActive(new Set(result.categories));
      } else {
        setError(result.message);
      }
    });
  }, []);

  async function handleToggle(category: ExclusionCategory, checked: boolean) {
    setError(null);
    const result = await setExclusion(getSupabaseBrowserClient(), candidateId, category, checked);

    if (result.kind === "error") {
      setError(result.message);
      return;
    }

    setActive((previous) => {
      const next = new Set(previous ?? []);

      if (checked) {
        next.add(category);
      } else {
        next.delete(category);
      }

      return next;
    });
  }

  return (
    <section aria-labelledby="exclusions-title" className="foundation-card">
      <h2 id="exclusions-title">Exclusions</h2>
      {error && <p role="alert">{error}</p>}
      {EXCLUSION_CATEGORIES.map((category) => (
        <label key={category}>
          <input
            type="checkbox"
            checked={active?.has(category) ?? false}
            onChange={(event) => void handleToggle(category, event.target.checked)}
          />
          {EXCLUSION_LABELS[category]}
        </label>
      ))}
    </section>
  );
}

interface AutomationPanelProps {
  candidateId: string;
}

function AutomationPanel({ candidateId }: AutomationPanelProps) {
  const [authorization, setAuthorization] = useState<Authorization | "notYetAuthorized" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);

  async function refresh() {
    const result = await getAuthorization(getSupabaseBrowserClient());

    if (result.kind === "authorized") {
      setAuthorization(result.authorization);
    } else if (result.kind === "notYetAuthorized") {
      setAuthorization("notYetAuthorized");
    } else {
      setError(result.message);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(action: (client: ReturnType<typeof getSupabaseBrowserClient>) => Promise<{ kind: string; message?: string }>) {
    setBusy(true);
    setError(null);
    const result = await action(getSupabaseBrowserClient());

    if (result.kind === "error" && result.message) {
      setError(result.message);
      setBusy(false);
      return;
    }

    await refresh();
    setBusy(false);
  }

  return (
    <section aria-labelledby="automation-title" className="foundation-card">
      <h2 id="automation-title">Automation</h2>
      {error && <p role="alert">{error}</p>}

      {authorization === "notYetAuthorized" && (
        <>
          <ul>
            {CONSENT_DISCLOSURE.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <button type="button" disabled={busy} onClick={() => void run((client) => authorize(client, candidateId))}>
            Authorize
          </button>
        </>
      )}

      {authorization && authorization !== "notYetAuthorized" && (
        <>
          <p>Status: {authorization.status}</p>
          {authorization.status !== "paused" && (
            <button type="button" disabled={busy} onClick={() => void run((client) => pause(client, candidateId))}>
              Pause
            </button>
          )}
          {authorization.status === "paused" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run((client) => resumeAutomation(client, candidateId))}
            >
              Resume
            </button>
          )}
          {authorization.status !== "stopped" && (
            <button type="button" disabled={busy} onClick={() => void run((client) => stop(client, candidateId))}>
              Stop
            </button>
          )}
        </>
      )}
    </section>
  );
}

function CompaniesPanel() {
  const [companies, setCompanies] = useState<CompanyIntelligenceEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listVerifiedCompanies(getSupabaseBrowserClient()).then((result) => {
      if (result.kind === "success") {
        setCompanies(result.companies);
      } else {
        setError(result.message);
      }
    });
  }, []);

  return (
    <section aria-labelledby="companies-title" className="foundation-card">
      <h2 id="companies-title">Verified Companies</h2>
      {error && <p role="alert">{error}</p>}
      {companies?.length === 0 && <p>No verified company profiles yet.</p>}
      <ul>
        {companies?.map((company) => (
          <li key={company.companyId}>
            <strong>{company.displayedName}</strong>
            {company.domain && ` — ${company.domain}`}
            <ul>
              {company.profile.industry && <li>Industry: {company.profile.industry}</li>}
              {company.profile.headquartersCountry && <li>Headquarters: {company.profile.headquartersCountry}</li>}
              {company.profile.employeeSizeRange && <li>Employees: {company.profile.employeeSizeRange}</li>}
              {company.profile.foundedYear && <li>Founded: {company.profile.foundedYear}</li>}
              {company.profile.publicPrivateStatus && <li>Status: {company.profile.publicPrivateStatus}</li>}
            </ul>
            {company.legalEntities.length > 0 && (
              <ul>
                {company.legalEntities.map((entity) => (
                  <li key={entity.id}>
                    {entity.legalName} ({entity.jurisdiction}, {entity.registryIdentifier})
                    {entity.registrationStatus && ` — ${entity.registrationStatus}`}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SalaryBenchmarksPanel() {
  const [benchmarks, setBenchmarks] = useState<SalaryBenchmarkEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listSalaryBenchmarks(getSupabaseBrowserClient()).then((result) => {
      if (result.kind === "success") {
        setBenchmarks(result.benchmarks);
      } else {
        setError(result.message);
      }
    });
  }, []);

  return (
    <section aria-labelledby="salary-benchmarks-title" className="foundation-card">
      <h2 id="salary-benchmarks-title">Salary Benchmarks</h2>
      {error && <p role="alert">{error}</p>}
      {benchmarks?.length === 0 && <p>No salary benchmarks published yet.</p>}
      <ul>
        {benchmarks?.map((benchmark) => (
          <li key={benchmark.id}>
            {benchmark.roleLabel}
            {benchmark.region && ` (${benchmark.region})`}: {benchmark.salaryMin ?? "?"}–{benchmark.salaryMax ?? "?"}{" "}
            {benchmark.currency}/{benchmark.salaryInterval} — {benchmark.benchmarkSource}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SecurityPanel() {
  const [factors, setFactors] = useState<TotpFactorSummary[] | null>(null);
  const [pendingEnrollment, setPendingEnrollment] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [revokeMessage, setRevokeMessage] = useState<string | null>(null);

  async function refreshFactors() {
    const result = await listTotpFactors(getSupabaseBrowserClient());

    if (result.kind === "success") {
      setFactors(result.factors);
    } else {
      setError(result.message);
    }
  }

  useEffect(() => {
    void refreshFactors();
  }, []);

  async function handleEnroll() {
    setError(null);

    // A previously abandoned enrollment (e.g. the tab closed mid-QR-scan)
    // leaves an unverified factor behind, which GoTrue then rejects a new
    // enroll() against with a friendly-name conflict — since re-fetching a
    // QR/secret for an existing unverified factor isn't possible, clearing
    // it first is the only way to let the candidate start over.
    const stale = factors?.filter((factor) => factor.status === "unverified") ?? [];

    for (const factor of stale) {
      const cleanupResult = await unenrollFactor(getSupabaseBrowserClient(), factor.id);

      if (cleanupResult.kind === "error") {
        setError(cleanupResult.message);
        return;
      }
    }

    const result = await enrollTotp(getSupabaseBrowserClient());

    if (result.kind === "error") {
      setError(result.message);
      return;
    }

    setPendingEnrollment(result.enrollment);
  }

  async function handleVerify() {
    if (!pendingEnrollment) {
      return;
    }

    setError(null);
    const result = await verifyEnrollment(getSupabaseBrowserClient(), pendingEnrollment.factorId, code);

    if (result.kind === "error") {
      setError(result.message);
      return;
    }

    setPendingEnrollment(null);
    setCode("");
    await refreshFactors();
  }

  async function handleUnenroll(factorId: string) {
    setError(null);
    const result = await unenrollFactor(getSupabaseBrowserClient(), factorId);

    if (result.kind === "error") {
      setError(result.message);
      return;
    }

    await refreshFactors();
  }

  async function handleRevokeOtherSessions() {
    setError(null);
    setRevokeMessage(null);
    const result = await revokeOtherSessions(getSupabaseBrowserClient());

    if (result.kind === "error") {
      setError(result.message);
      return;
    }

    setRevokeMessage("Other sessions have been signed out.");
  }

  const verifiedFactor = factors?.find((factor) => factor.status === "verified") ?? null;

  return (
    <section aria-labelledby="security-title" className="foundation-card">
      <h2 id="security-title">Security</h2>
      {error && <p role="alert">{error}</p>}
      {revokeMessage && <p role="status">{revokeMessage}</p>}

      {verifiedFactor ? (
        <>
          <p>Two-factor authentication is enabled.</p>
          <button type="button" onClick={() => void handleUnenroll(verifiedFactor.id)}>
            Turn off two-factor authentication
          </button>
        </>
      ) : pendingEnrollment ? (
        <>
          <img
            // supabase-js's own mfa.enroll() already returns a complete
            // data: URI here (confirmed against installed @supabase/auth-js
            // source — its type-doc comment saying to prepend the prefix
            // yourself is stale), so this is used as-is, not re-wrapped.
            src={pendingEnrollment.qrCodeSvg}
            alt="Scan this QR code with your authenticator app"
          />
          <p>Or enter this code manually: {pendingEnrollment.secret}</p>
          <label htmlFor="totp-code">Authenticator code</label>
          <input id="totp-code" value={code} onChange={(event) => setCode(event.target.value)} />
          <button type="button" onClick={() => void handleVerify()}>
            Verify
          </button>
        </>
      ) : (
        <button type="button" onClick={() => void handleEnroll()}>
          Set up two-factor authentication
        </button>
      )}

      <button type="button" onClick={() => void handleRevokeOtherSessions()}>
        Sign out other sessions
      </button>
    </section>
  );
}
