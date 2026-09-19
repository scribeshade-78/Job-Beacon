-- Task H3: real ATS application adapters — credentials, output hashing, and
-- credential-conditional policy activation.
--
-- TRACED TO PRD v3, QUOTED WHERE IT DECIDES SOMETHING:
--
--   §10.2 Greenhouse: "Application POST requires Basic Auth/API credentials
--        controlled by the employer and should be proxied server-side. [S1]"
--        Product requirement: "enable direct application only with authorized
--        credentials or permitted hosted flow."
--   §10.2 Lever: "POST application requires an employer-generated API key and
--        rate-limit handling. [S2]" Product requirement: "direct submission only
--        with employer authorization."
--   §16.2 "Authorized ATS API: Server submits using employer/source credentials
--        and handles validation/rate limits."
--   §16.3 "Record source facts, template version, model/prompt version and
--        output hash." and "Run factuality, formatting and ATS quality checks."
--
-- THE CENTRAL POINT OF THIS FILE IS THAT THE POLICY FLAG IS NOT SET BY HAND.
-- §10.2 permits direct application "only with authorized credentials", so
-- automated_application_allowed for these two sources is DERIVED from whether an
-- active employer credential exists, and a trigger keeps it that way. Seeding it
-- to true would have been the easy thing to do and would have been false: with
-- no employer key this deployment cannot submit to either ATS, and a policy row
-- claiming otherwise is exactly the "UI promises what the backend cannot do"
-- failure this project keeps refusing to ship.

-- ---------------------------------------------------------------------------
-- 1. Employer ATS credentials.
--
-- PER EMPLOYER, NOT PER SOURCE, because that is what the credentials actually
-- are: a Greenhouse Job Board API key authorizes submissions to ONE employer's
-- board, and a Lever API key belongs to ONE Lever account. A single
-- GREENHOUSE_API_KEY environment variable could therefore only ever serve one
-- employer — which is what the pre-H3 adapter did, and why it was never
-- registerable as a general source.
--
-- STORED ENCRYPTED, never in plaintext and never in the browser. The ciphertext
-- is an AES-256-GCM envelope produced by server/mailbox/tokenCrypto.ts, the same
-- primitive mailbox OAuth tokens already use under a different key. The column
-- is named secret_ciphertext rather than "api_key" so that nobody reading a
-- query result mistakes it for something usable.
--
-- key_hint is the last four characters only. It exists so an operator can tell
-- WHICH key is installed without decrypting anything — "is the board key the one
-- ending 4f2a or the old one?" is a real question during a rotation, and the
-- alternative is a decrypt-and-log path that this schema deliberately avoids.
-- ---------------------------------------------------------------------------
create table public.ats_credentials (
  id uuid primary key default gen_random_uuid(),
  source_code text not null,
  /** Greenhouse board token, or Lever site/account identifier. The scope the key is valid for. */
  employer_key text not null,
  /** Set when the employer is a known company, so an operator can see whose key this is. */
  company_id uuid references public.companies (id) on delete set null,
  label text,

  secret_ciphertext text not null,
  key_hint text not null,

  is_active boolean not null default true,
  last_used_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (source_code, employer_key),
  check (source_code in ('greenhouse', 'lever')),
  check (length(trim(employer_key)) > 0),
  check (length(key_hint) > 0)
);

comment on table public.ats_credentials is
  'Employer-issued ATS submission credentials (PRD v3 §10.2). One row per (source, employer). secret_ciphertext is AES-256-GCM encrypted and is never returned to a client; only an operator-facing key_hint is readable.';

comment on column public.ats_credentials.employer_key is
  'The scope this credential authorizes: a Greenhouse board token, or a Lever site/account. Credentials are per-employer, not per-source — one Greenhouse key authorizes exactly one employer''s board.';

-- RLS with NO policy and no grant to authenticated or anon. This table holds
-- secrets, so the correct number of client-visible rows is zero; service_role is
-- the only reader. Deliberately not a select-own policy: a credential is the
-- employer's, not the candidate's.
alter table public.ats_credentials enable row level security;

revoke all on public.ats_credentials from public, anon, authenticated;
grant select, insert, update, delete on public.ats_credentials to service_role;

-- ---------------------------------------------------------------------------
-- 2. §16.3 provenance on the generated resume.
--
-- The generator already computes a template version, a model version and a
-- digest of the confirmed facts it used — and storeTailoredResume discarded all
-- three, recording only the file. §16.3 says to record them, and it also says
-- "output hash", which is a different thing from the facts digest the generator
-- was calling outputHash: one pins WHICH FACTS produced the document, the other
-- pins THE BYTES THAT WERE SENT. Both are needed to answer "is the file we
-- submitted the file we generated, from the facts we think we used", so both
-- get a column and the existing digest is renamed on the way in rather than
-- silently left mislabelled.
--
-- NULL is allowed on all of them: pre-H3 documents exist that have no hashes,
-- and fabricating a hash for a file that was never hashed would be worse than an
-- honest NULL.
-- ---------------------------------------------------------------------------
alter table public.resume_documents
  add column if not exists output_sha256 text,
  add column if not exists facts_sha256 text,
  add column if not exists template_version text,
  add column if not exists model_version text,
  add column if not exists ats_checks jsonb,
  add column if not exists ats_checked_at timestamptz;

alter table public.resume_documents
  add constraint resume_documents_output_sha256_check
    check (output_sha256 is null or output_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint resume_documents_facts_sha256_check
    check (facts_sha256 is null or facts_sha256 ~ '^[0-9a-f]{64}$');

comment on column public.resume_documents.output_sha256 is
  'SHA-256 of the exact document bytes stored at storage_path (PRD v3 §16.3 "output hash"). This is what ties a submitted file to a generated one; facts_sha256 is the separate digest of the confirmed facts used to produce it.';

comment on column public.resume_documents.ats_checks is
  'The ATS/format quality check results (PRD v3 §16.3) recorded at generation time, so a later reviewer sees what was verified about this exact file.';

-- ---------------------------------------------------------------------------
-- 3. The two real sources, disabled until an employer authorizes them.
-- ---------------------------------------------------------------------------
insert into public.source_policies (
  source_code, discovery_allowed, storage_allowed, display_allowed,
  automated_application_allowed, authentication_method, rate_limit, countries, policy_version
) values
  ('greenhouse', true, true, true, false, 'employer_issued_api_key',
   'Board API; employer-controlled. Application POST must be proxied server-side (PRD 10.2 [S1]).', '{IN,US,EU}', 'h3-v1'),
  ('lever', true, true, true, false, 'employer_issued_api_key',
   'Postings API; application create requests are rate limited and 429 must be handled (PRD 10.2 [S2]).', '{IN,US,EU}', 'h3-v1')
on conflict (source_code) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Deriving the flag from credentials, so it cannot drift from reality.
--
-- A function rather than a one-off UPDATE because the answer changes over time:
-- the moment an operator installs an employer key the source becomes appliable,
-- and the moment the key is deactivated or deleted it must stop being appliable.
-- A hand-set boolean would have to be remembered at both of those moments, and
-- forgetting the second one is how a deployment ends up attempting submissions
-- it has no authorization for.
--
-- Only greenhouse and lever are touched. Every other source's flag is governed
-- by its own policy reasoning and must not be overwritten by this function.
-- ---------------------------------------------------------------------------
create function public.refresh_source_application_policy()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.source_policies sp
  set automated_application_allowed = exists (
        select 1
        from public.ats_credentials c
        where c.source_code = sp.source_code
          and c.is_active
      ),
      updated_at = now()
  where sp.source_code in ('greenhouse', 'lever');
end;
$$;

comment on function public.refresh_source_application_policy() is
  'Sets automated_application_allowed for the ATS sources from the existence of an active employer credential (PRD v3 §10.2: direct application "only with authorized credentials"). Called by a trigger on ats_credentials; safe to call by hand after a manual data fix.';

create function public.ats_credentials_refresh_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Statement-level, so a bulk credential change refreshes the policy once
  -- rather than once per row.
  perform public.refresh_source_application_policy();
  return null;
end;
$$;

create trigger ats_credentials_sync_policy
  after insert or update or delete on public.ats_credentials
  for each statement
  execute function public.ats_credentials_refresh_policy();

revoke all on function public.refresh_source_application_policy() from public, anon, authenticated;
revoke all on function public.ats_credentials_refresh_policy() from public, anon, authenticated;

-- Applies the derivation now. With no credentials installed this leaves both
-- sources at automated_application_allowed = false, which is the honest state:
-- the adapters exist, the authorization does not.
select public.refresh_source_application_policy();

-- ---------------------------------------------------------------------------
-- 5. NOT DONE HERE, DELIBERATELY: no vacancy_sources rows for these two sources.
--
-- Both have a registered DISCOVERY adapter already (server/ingestion/adapters/
-- greenhouse.ts and lever.ts), so the obvious next step is to seed their
-- vacancy_sources rows. Two things stop it, and both are reasons rather than
-- oversights:
--
--   1. vacancy_sources.target_key is NOT NULL, and for these two sources that
--      value is the employer's own identifier - a Greenhouse board token, or a
--      Lever site. That is exactly what ats_credentials.employer_key now holds,
--      per employer. Writing one into a source-level row would duplicate it or,
--      worse, pin discovery to one employer while describing the whole source.
--   2. There is no value to write that is not invented. This deployment has no
--      employer relationships, so any token here would be fabricated
--      configuration that fails on the first real request.
-- ---------------------------------------------------------------------------
-- The operator adds the vacancy_sources row and the credential together, once
-- there is an employer to add them for. Until then discovery for these sources
-- is simply not configured, which shows in the admin console as an absent row
-- rather than a broken one.
