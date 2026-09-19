import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret, readEncryptionKey } from "../mailbox/tokenCrypto.js";

/**
 * Task H3 — employer ATS credentials, stored encrypted and resolved per employer.
 *
 * WHY A TABLE AND NOT AN ENVIRONMENT VARIABLE. PRD v3 §10.2 is explicit that
 * these keys belong to the employer: a Greenhouse Job Board API key authorizes
 * submissions to ONE employer's board, and a Lever API key belongs to ONE Lever
 * account. A single GREENHOUSE_API_KEY variable can therefore only ever serve
 * one employer, which is why the pre-H3 adapter — which read exactly that — could
 * never be registered as a general source. This module replaces it with a store
 * keyed by (source, employer), which is the shape the credentials actually have.
 *
 * ENCRYPTED AT REST UNDER ITS OWN KEY. ATS_CREDENTIAL_ENCRYPTION_KEY, a separate
 * environment variable from the mailbox token key, because the two secrets have
 * different blast radii: a leaked mailbox token exposes one candidate's inbox,
 * a leaked employer key can submit job applications in that employer's name.
 * Separate keys mean neither compromise implies the other.
 *
 * NO SECRET EVER LEAVES THIS MODULE EXCEPT VIA loadAtsCredentialSecret, whose
 * return value is passed straight to an HTTP Authorization header. The list
 * function returns key HINTS only, so an admin screen can show which key is
 * installed without a decrypt path existing for display purposes.
 */

export type AtsSourceCode = "greenhouse" | "lever";

export const ATS_SOURCE_CODES: readonly AtsSourceCode[] = ["greenhouse", "lever"];

export const ATS_CREDENTIAL_KEY_ENV = "ATS_CREDENTIAL_ENCRYPTION_KEY";

export class AtsCredentialKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtsCredentialKeyError";
  }
}

/** Throws when unset or the wrong length; callers that must not throw should catch. */
export function readAtsCredentialKey(env: Record<string, string | undefined> = process.env): Buffer {
  try {
    return readEncryptionKey(ATS_CREDENTIAL_KEY_ENV, env);
  } catch (error) {
    throw new AtsCredentialKeyError(error instanceof Error ? error.message : String(error));
  }
}

export interface AtsCredentialSummary {
  id: string;
  sourceCode: AtsSourceCode;
  employerKey: string;
  label: string | null;
  companyId: string | null;
  /** Last four characters of the key. Enough to identify it, useless to an attacker without the rest. */
  keyHint: string;
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

interface CredentialRow {
  id: string;
  source_code: AtsSourceCode;
  employer_key: string;
  company_id: string | null;
  label: string | null;
  key_hint: string;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
}

/** Summaries only — deliberately does not select secret_ciphertext. */
export async function listAtsCredentials(client: SupabaseClient): Promise<AtsCredentialSummary[]> {
  const { data, error } = await client
    .from("ats_credentials")
    .select("id, source_code, employer_key, company_id, label, key_hint, is_active, last_used_at, created_at")
    .order("source_code")
    .order("employer_key");

  if (error) {
    throw error;
  }

  return ((data ?? []) as CredentialRow[]).map((row) => ({
    id: row.id,
    sourceCode: row.source_code,
    employerKey: row.employer_key,
    label: row.label,
    companyId: row.company_id,
    keyHint: row.key_hint,
    isActive: row.is_active,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  }));
}

export interface LoadedAtsCredential {
  id: string;
  secret: string;
}

/**
 * The one function that returns a usable secret.
 *
 * Returns null when there is no ACTIVE credential for that employer — null and
 * not a throw, because "this employer has not authorized us" is an ordinary
 * answer that the eligibility gate is expected to have already accounted for,
 * and turning it into an exception here would make it look like a fault.
 * An inactive row deliberately resolves to null: deactivating a key is how an
 * employer withdraws authorization, and the trigger on this table flips the
 * source policy off at the same moment, so the two cannot disagree.
 */
export async function loadAtsCredentialSecret(
  client: SupabaseClient,
  sourceCode: AtsSourceCode,
  employerKey: string,
  env: Record<string, string | undefined> = process.env,
): Promise<LoadedAtsCredential | null> {
  const { data, error } = await client
    .from("ats_credentials")
    .select("id, secret_ciphertext")
    .eq("source_code", sourceCode)
    .eq("employer_key", employerKey)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  const row = data as { id: string; secret_ciphertext: string };

  return { id: row.id, secret: decryptSecret(readAtsCredentialKey(env), row.secret_ciphertext) };
}

export interface StoreAtsCredentialInput {
  sourceCode: AtsSourceCode;
  employerKey: string;
  secret: string;
  label?: string | null;
  companyId?: string | null;
}

/**
 * Creates or replaces the credential for one (source, employer), and records the
 * key hint.
 *
 * Upsert rather than insert-only: rotating a key is the normal operation and
 * requiring a delete first would leave a window with no credential at all, which
 * the trigger would faithfully turn into the source being disabled mid-rotation.
 */
export async function storeAtsCredential(
  client: SupabaseClient,
  input: StoreAtsCredentialInput,
  env: Record<string, string | undefined> = process.env,
): Promise<{ id: string }> {
  const secret = input.secret.trim();

  if (secret.length === 0) {
    throw new Error("Refusing to store an empty ATS credential.");
  }

  const ciphertext = encryptSecret(readAtsCredentialKey(env), secret);
  const keyHint = secret.slice(-4);

  const { data, error } = await client
    .from("ats_credentials")
    .upsert(
      {
        source_code: input.sourceCode,
        employer_key: input.employerKey,
        company_id: input.companyId ?? null,
        label: input.label ?? null,
        secret_ciphertext: ciphertext,
        key_hint: keyHint,
        is_active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "source_code,employer_key" },
    )
    .select("id")
    .single();

  if (error || !data) {
    throw error ?? new Error("ATS credential upsert returned no row.");
  }

  return { id: (data as { id: string }).id };
}

/** Deactivating is how an employer withdraws authorization; the trigger disables the source. */
export async function setAtsCredentialActive(
  client: SupabaseClient,
  id: string,
  isActive: boolean,
): Promise<void> {
  const { error } = await client
    .from("ats_credentials")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    throw error;
  }
}

/**
 * Best-effort usage stamp. Never allowed to fail a submission: a credential that
 * worked is not invalidated by a bookkeeping write going wrong, so a failure here
 * is logged and swallowed — the same stance poll.ts takes for its post-poll
 * status writes.
 */
export async function markAtsCredentialUsed(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client
    .from("ats_credentials")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    console.error("[ats:credentials] failed to stamp last_used_at", { id, error });
  }
}
