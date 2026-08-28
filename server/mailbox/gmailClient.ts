import type { FetchImpl } from "./oauth.js";

/**
 * R6.2: plain fetch against Gmail's REST API — same "no SDK for a stable
 * REST API" convention as oauth.ts / server/companies/mcaRegistry.ts.
 */
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/**
 * `format=metadata` for anything whose result reaches messages.raw_payload
 * — never `format=full` on the persisted path. raw_payload is meant to
 * hold Gmail's own response shape verbatim (see 20260820140010_messages.sql's
 * comment), but that migration deliberately has no body/content column:
 * fetching `format=full` here would pull the email body into raw_payload
 * anyway, defeating that decision. (fetchMessagePlainText below does use
 * `format=full`, but returns only the decoded text for in-memory
 * classification and persists nothing.) `q=in:inbox`
 * excludes Spam/Trash/Promotions/Social — reading the minimum necessary,
 * not a relevance filter (response_classifications, not ingestion, decides
 * what's actually a recruiter reply).
 */
export async function listRecentMessageIds(
  accessToken: string,
  sinceUnixSeconds: number,
  fetchImpl: FetchImpl = fetch,
): Promise<string[]> {
  const url = new URL(`${GMAIL_API_BASE}/messages`);
  url.searchParams.set("q", `in:inbox after:${sinceUnixSeconds}`);

  const response = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new GmailApiError(`Gmail messages.list failed: HTTP ${response.status}`, response.status);
  }

  const body = (await response.json()) as { messages?: Array<{ id: string }> };
  return (body.messages ?? []).map((message) => message.id);
}

export interface GmailMessageMetadata {
  id: string;
  sender: string | null;
  subject: string | null;
  receivedAt: string | null;
  /** Gmail's response verbatim — stored as-is in messages.raw_payload, same "no invented shape" precedent as vacancy_evidence.payload. */
  raw: unknown;
}

function findHeader(headers: Array<{ name: string; value: string }> | undefined, name: string): string | null {
  return headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

export async function fetchMessageMetadata(
  accessToken: string,
  messageId: string,
  fetchImpl: FetchImpl = fetch,
): Promise<GmailMessageMetadata> {
  const url = new URL(`${GMAIL_API_BASE}/messages/${messageId}`);
  url.searchParams.set("format", "metadata");
  url.searchParams.append("metadataHeaders", "From");
  url.searchParams.append("metadataHeaders", "Subject");

  const response = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new GmailApiError(`Gmail messages.get failed: HTTP ${response.status}`, response.status);
  }

  const body = (await response.json()) as {
    id: string;
    internalDate?: string;
    payload?: { headers?: Array<{ name: string; value: string }> };
  };

  return {
    id: body.id,
    sender: findHeader(body.payload?.headers, "From"),
    subject: findHeader(body.payload?.headers, "Subject"),
    // internalDate is epoch milliseconds as a string (Gmail API's own convention).
    receivedAt: body.internalDate ? new Date(Number(body.internalDate)).toISOString() : null,
    raw: body,
  };
}

/** Bounds the classifier prompt cost — recruiter emails carry their signal well within this; the tail is quoted history and signatures. */
const MAX_BODY_TEXT_CHARS = 20_000;

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function findPlainTextPart(part: GmailPart | undefined): string | null {
  if (!part) {
    return null;
  }
  if (part.mimeType === "text/plain" && part.body?.data) {
    return part.body.data;
  }
  for (const child of part.parts ?? []) {
    const found = findPlainTextPart(child);
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * R6.3 (Response Intelligence): fetches the message's plain-text body for
 * in-memory AI classification only — the founder-approved "Option B" of
 * this phase. `format=full` is used here (the one place it's allowed:
 * fetchMessageMetadata above still uses `format=metadata` so the body
 * never lands in messages.raw_payload), and the decoded text is returned
 * directly and never persisted. Returns null when the message has no
 * text/plain part (HTML-only mail) — the classifier then works from
 * sender + subject alone rather than this function guessing at markup.
 */
export async function fetchMessagePlainText(
  accessToken: string,
  messageId: string,
  fetchImpl: FetchImpl = fetch,
): Promise<string | null> {
  const url = new URL(`${GMAIL_API_BASE}/messages/${messageId}`);
  url.searchParams.set("format", "full");

  const response = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new GmailApiError(`Gmail messages.get (full) failed: HTTP ${response.status}`, response.status);
  }

  const body = (await response.json()) as { payload?: GmailPart };
  const encoded = findPlainTextPart(body.payload);

  if (!encoded) {
    return null;
  }

  // Gmail encodes part bodies as base64url.
  const decoded = Buffer.from(encoded, "base64url").toString("utf8").trim();
  return decoded ? decoded.slice(0, MAX_BODY_TEXT_CHARS) : null;
}
