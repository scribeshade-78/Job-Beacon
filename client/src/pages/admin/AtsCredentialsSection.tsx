import { useEffect, useState, type FormEvent } from "react";
import {
  ATS_SOURCE_CODES,
  listAtsCredentials,
  setAtsCredentialActive,
  storeAtsCredential,
  type AtsCredentialSummary,
  type AtsSourceCode,
} from "../../lib/audit";
import { AdminCard, SectionMessage, getAccessToken } from "./shared";

/**
 * Task H4 — employer ATS submission credentials.
 *
 * WHAT IS BEING MANAGED HERE, because it is easy to read this screen as generic
 * API-key plumbing: these keys belong to the EMPLOYER, not to us. A Greenhouse
 * Job Board API key authorizes submissions to one employer's board; a Lever API
 * key is generated for one Lever account by that account's Super Admin. That is
 * why the store is keyed by (source, employer) rather than held in a single
 * GREENHOUSE_API_KEY environment variable — one variable could only ever have
 * served one employer, which is exactly why the pre-H3 adapter could not be
 * registered as a general source.
 *
 * THE KEY IS WRITE-ONLY FROM THIS SCREEN. It goes in through a password input,
 * into one request body, and out of the component's state the moment the server
 * accepts it. Nothing here renders it, and there is no "show key" affordance to
 * render it from — the list route does not select the ciphertext at all, so a
 * reveal button could not be wired up even if someone added one. The four
 * characters in key_hint are the part designed to be shown: enough to tell which
 * key is installed, useless for using it.
 *
 * INSTALLING AN ACTIVE CREDENTIAL IS THE SWITCH. There is no separate "enable
 * automated application" toggle, here or in the database: a trigger on
 * ats_credentials re-derives the source policy from whether an active credential
 * exists, creating the source_policies row when authorization arrives and
 * clearing the flag when the last one is deactivated. Deactivating is therefore
 * how an employer's authorization is withdrawn, and it is audited for that
 * reason.
 */

function Timestamp({ value, fallback }: { value: string | null; fallback: string }) {
  if (!value) {
    return <span className="text-xs text-slate-500">{fallback}</span>;
  }
  // Raw value on hover: locale output drops the offset, and rotation decisions
  // are made against the stored instant.
  return (
    <span title={value} className="font-mono text-xs text-slate-400">
      {new Date(value).toLocaleString()}
    </span>
  );
}

const FIELD_CLASS =
  "mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200 placeholder:text-slate-600";

const BUTTON_CLASS =
  "rounded bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-700 disabled:opacity-40";

export function AtsCredentialsSection() {
  const [credentials, setCredentials] = useState<AtsCredentialSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [sourceCode, setSourceCode] = useState<AtsSourceCode>("greenhouse");
  const [employerKey, setEmployerKey] = useState("");
  const [label, setLabel] = useState("");

  /**
   * The only place an entered key exists on the client: the state behind the
   * password input. It is written straight into the storeAtsCredential request
   * body and cleared on success — deliberately NOT cleared on failure, so that a
   * rejection about the employer key or a deployment missing its encryption key
   * does not force the operator to go and fetch the key from the employer again.
   */
  const [secret, setSecret] = useState("");

  async function load() {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      setError("Your session has expired.");
      return;
    }

    const result = await listAtsCredentials(accessToken);
    if (result.kind === "success") {
      setCredentials(result.data.credentials);
      setError(null);
    } else if (result.kind === "forbidden") {
      setError("You don't have admin access.");
    } else {
      setError(result.message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggle(credential: AtsCredentialSummary) {
    setBusy(true);
    setError(null);
    setNotice(null);

    const accessToken = await getAccessToken();
    if (!accessToken) {
      setError("Your session has expired.");
      setBusy(false);
      return;
    }

    const result = await setAtsCredentialActive(credential.id, !credential.isActive, accessToken);
    if (result.kind === "success") {
      // The section re-reads rather than patching the row in place: the same
      // trigger that flipped this credential may have created or cleared the
      // source policy, and the server's note states which way that went.
      setNotice(result.data.note);
      await load();
    } else if (result.kind === "forbidden") {
      setError("You don't have admin access.");
    } else {
      setError(result.message);
    }

    setBusy(false);
  }

  async function submit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    const accessToken = await getAccessToken();
    if (!accessToken) {
      setError("Your session has expired.");
      setBusy(false);
      return;
    }

    const result = await storeAtsCredential(
      {
        sourceCode,
        employerKey: employerKey.trim(),
        secret,
        // Omitted rather than sent empty: the route normalises "" to null anyway,
        // and an absent key is the honest representation of "no label given".
        label: label.trim() === "" ? undefined : label.trim(),
      },
      accessToken,
    );

    if (result.kind === "success") {
      setSecret("");
      setEmployerKey("");
      setLabel("");
      // The hint is the confirmation. It is the only part of the key the server
      // will ever hand back, and it is what tells the operator that the key they
      // pasted is the key that got installed.
      setNotice(
        "Installed the " +
          result.data.sourceCode +
          " credential for " +
          result.data.employerKey +
          ". The stored key ends in " +
          result.data.keyHint +
          " — that hint is the only part of it any API returns.",
      );
      await load();
    } else if (result.kind === "forbidden") {
      setError("You don't have admin access.");
    } else {
      setError(result.message);
    }

    setBusy(false);
  }

  return (
    <div className="space-y-4">
      <AdminCard
        title="Installed credentials"
        description="One row per (source, employer) in ats_credentials. The key itself is not in this response and is not in the database in a readable form — only the last four characters are, so an operator can tell the keys apart without being able to use one."
      >
        {error && <SectionMessage tone="error">{error}</SectionMessage>}
        {notice && (
          <p className="mb-3 text-sm text-emerald-300" role="status">
            {notice}
          </p>
        )}

        {credentials === null ? (
          <SectionMessage tone="muted">Loading…</SectionMessage>
        ) : credentials.length === 0 ? (
          <SectionMessage tone="muted">
            No credentials installed. Automated application is therefore off for every ATS source — no active
            credential, no source policy.
          </SectionMessage>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] border-collapse text-left">
              <thead>
                <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-4 font-medium">Source</th>
                  <th className="py-2 pr-4 font-medium">Employer</th>
                  <th className="py-2 pr-4 font-medium">Label</th>
                  <th className="py-2 pr-4 font-medium">Key</th>
                  <th className="py-2 pr-4 font-medium">State</th>
                  <th className="py-2 pr-4 font-medium">Last used</th>
                  <th className="py-2 pr-4 font-medium">Installed</th>
                  <th className="py-2 pr-4 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {credentials.map((credential) => (
                  <tr key={credential.id} className="border-b border-slate-900 align-top">
                    <td className="py-2 pr-4 font-mono text-xs text-slate-300">{credential.sourceCode}</td>
                    <td className="py-2 pr-4">
                      <span className="break-all font-mono text-xs text-slate-300">{credential.employerKey}</span>
                    </td>
                    <td className="py-2 pr-4 text-xs text-slate-400">{credential.label ?? "—"}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-slate-400">••••{credential.keyHint}</td>
                    <td className="py-2 pr-4 text-xs">
                      {credential.isActive ? (
                        <span className="text-emerald-300">Active</span>
                      ) : (
                        <span className="text-slate-500">
                          Inactive — this credential cannot be used to submit
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      <Timestamp value={credential.lastUsedAt} fallback="Never used" />
                    </td>
                    <td className="py-2 pr-4">
                      <Timestamp value={credential.createdAt} fallback="—" />
                    </td>
                    <td className="py-2 pr-4">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void toggle(credential)}
                        className={BUTTON_CLASS}
                      >
                        {credential.isActive ? "Deactivate" : "Activate"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>

      <AdminCard title="Add credential" description="Installs or rotates the credential for one (source, employer). Rotating replaces the stored key in place rather than deleting first, so the source is never briefly unauthorized mid-rotation.">
        <p className="mb-4 text-xs text-slate-500">
          The key is issued by the employer, not by us — a Greenhouse Job Board API key, or a Lever API key a Super
          Admin on that Lever account generates. It is encrypted on the server under its own key
          (ATS_CREDENTIAL_ENCRYPTION_KEY, separate from the mailbox token key because the two have different blast
          radii) and no API ever returns it: this screen shows the last four characters and nothing more. Installing
          an <span className="text-slate-300">active</span> credential is what enables automated application for that
          source — the database derives the source policy from the credential's existence, so there is no second
          switch to remember and no way for the two to disagree. Deactivating a credential withdraws that
          employer's authorization; the source's automated application goes off once no active credential is left
          for it.
        </p>

        <form onSubmit={(formEvent) => void submit(formEvent)} className="space-y-3">
          {/* Each label carries only the field name and the hint sits outside it:
              wrapping the hint too would make the field's accessible name a
              sentence, which is what a screen reader would then read out as the
              control's name. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs text-slate-400" htmlFor="ats-source">
                Source
              </label>
              <select
                id="ats-source"
                value={sourceCode}
                onChange={(changeEvent) => setSourceCode(changeEvent.target.value as AtsSourceCode)}
                className={FIELD_CLASS}
              >
                {ATS_SOURCE_CODES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs text-slate-400" htmlFor="ats-employer-key">
                Employer key
              </label>
              <input
                id="ats-employer-key"
                type="text"
                required
                value={employerKey}
                onChange={(changeEvent) => setEmployerKey(changeEvent.target.value)}
                placeholder="e.g. acme-corp"
                className={FIELD_CLASS}
              />
              <span className="mt-1 block text-[11px] text-slate-600">
                The employer's board or account identifier. A key is scoped to one employer, so this is what decides
                whose applications it can submit.
              </span>
            </div>

            <div>
              <label className="block text-xs text-slate-400" htmlFor="ats-label">
                Label (optional)
              </label>
              <input
                id="ats-label"
                type="text"
                value={label}
                onChange={(changeEvent) => setLabel(changeEvent.target.value)}
                placeholder="e.g. Acme Corp — production"
                className={FIELD_CLASS}
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400" htmlFor="ats-secret">
                Secret
              </label>
              {/* type="password" and new-password are both load-bearing. The first
                  keeps the key off the screen; the second stops a browser password
                  manager offering to remember an employer's ATS key, which would
                  put a production credential in someone's personal vault. */}
              <input
                id="ats-secret"
                type="password"
                required
                autoComplete="new-password"
                value={secret}
                onChange={(changeEvent) => setSecret(changeEvent.target.value)}
                className={FIELD_CLASS}
              />
              <span className="mt-1 block text-[11px] text-slate-600">
                Sent once, encrypted on arrival, and never returned by any API — not even to this screen. Replacing an
                existing (source, employer) pair rotates that credential in place.
              </span>
            </div>
          </div>

          <button type="submit" disabled={busy} className={BUTTON_CLASS}>
            {busy ? "Saving…" : "Install credential"}
          </button>
        </form>
      </AdminCard>
    </div>
  );
}
