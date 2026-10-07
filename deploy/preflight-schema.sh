#!/usr/bin/env bash
#
# deploy/preflight-schema.sh — Stage 0 of deploy.sh. Blocks a deploy whose code
# expects a database the target does not have.
#
#   ./deploy/preflight-schema.sh          # run standalone to see the report
#
# WHY TWO CHECKS AND NOT ONE.
#
# Check A compares supabase_migrations.schema_migrations with supabase/migrations/.
# That is the obvious gate, and it is necessary — but it is NOT sufficient, and
# the 2026-10 incident is the proof. Migration 20261001180000 was applied, the
# schema cache was reloaded, and the migration WAS recorded in history — yet the
# Find Jobs feed and every job detail page stayed dead, because
# candidate_ranked_opportunities had been created (by 20261001340000) BEFORE the
# column existed, and its column list is a frozen snapshot of
# 'select o.* from candidate_opportunities'. History said "applied". The schema
# said otherwise. Check A alone would have reported success and shipped.
#
# Check B therefore asserts the deployed SCHEMA SHAPE against the columns the
# client actually selects, read straight out of client/src/lib/opportunities.ts's
# VIEW_COLUMNS array. It is derived, not hand-maintained, so it cannot rot: add a
# column to the feed's select list and this gate starts requiring it.
#
# CREDENTIALS. Both checks need one remote Postgres connection string:
#
#   export SUPABASE_DB_URL='postgresql://postgres.<ref>:<password>@<host>:5432/postgres'
#
# Supabase dashboard -> Project Settings -> Database -> Connection string (URI).
# Use the session/direct connection, not the transaction pooler, and never commit
# it — it carries the database password.
#
# psql is not required: if the host has none, psql runs in a throwaway
# postgres:17-alpine container. Docker must then be available.
#
# UNVERIFIABLE IS NOT A PASS. Missing credentials abort the deploy rather than
# waving it through; set PREFLIGHT_ALLOW_UNVERIFIED=1 to override deliberately.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="${REPO_ROOT}/supabase/migrations"
CLIENT_FEED="${REPO_ROOT}/client/src/lib/opportunities.ts"

# Relations the client reads, and one that must merely exist.
VIEW_RELATIONS="candidate_ranked_opportunities candidate_opportunities"
REQUIRED_TABLES="saved_vacancies dismissed_vacancies"

ALLOW_UNVERIFIED="${PREFLIGHT_ALLOW_UNVERIFIED:-0}"

log()  { printf '\n==> %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
fail() { printf '\n!! %s\n' "$*" >&2; exit 1; }

remote_query() {
  if command -v psql >/dev/null 2>&1; then
    psql "${SUPABASE_DB_URL}" -v ON_ERROR_STOP=1 -tA -c "$1"
  else
    command -v docker >/dev/null 2>&1 || return 127
    MSYS_NO_PATHCONV=1 docker run --rm -i postgres:17-alpine \
      psql "${SUPABASE_DB_URL}" -v ON_ERROR_STOP=1 -tA -c "$1"
  fi
}

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  if [ "${ALLOW_UNVERIFIED}" = "1" ]; then
    warn "SUPABASE_DB_URL is unset and PREFLIGHT_ALLOW_UNVERIFIED=1 — schema preflight SKIPPED. This deploy is unverified."
    exit 0
  fi
  fail "SUPABASE_DB_URL is not set, so the target schema cannot be verified.
     Refusing to deploy an unverified schema.
     Export it:  export SUPABASE_DB_URL='postgresql://...'
     Or override deliberately:  PREFLIGHT_ALLOW_UNVERIFIED=1 ./deploy/deploy.sh"
fi

# ---------------------------------------------------------------------------
# Check A — migration history parity
# ---------------------------------------------------------------------------
log "Check A: migration history parity"

local_versions="$(cd "${MIGRATIONS_DIR}" && for f in *.sql; do printf '%s\n' "${f%%_*}"; done | sort -u)"

if ! remote_versions="$(remote_query "select version from supabase_migrations.schema_migrations order by version;" 2>&1)"; then
  fail "Could not read supabase_migrations.schema_migrations.
     Check SUPABASE_DB_URL and network access.
--- psql said ---
${remote_versions}"
fi
remote_versions="$(printf '%s\n' "${remote_versions}" | tr -d '\r' | grep -E '^[0-9]{14}$' | sort -u || true)"

if [ -z "${remote_versions}" ]; then
  fail "Migration history came back empty. Either the database has never had a
     migration recorded (nothing was ever applied via supabase db push / the
     Supabase CLI), or the query returned nothing usable. A history that cannot
     be read is not a history that can be trusted."
fi

missing_on_remote="$(comm -23 <(printf '%s\n' "${local_versions}") <(printf '%s\n' "${remote_versions}") || true)"
extra_on_remote="$(comm -13 <(printf '%s\n' "${local_versions}") <(printf '%s\n' "${remote_versions}") || true)"

local_count="$(printf '%s\n' "${local_versions}" | grep -c . || true)"
remote_count="$(printf '%s\n' "${remote_versions}" | grep -c . || true)"
printf '    local: %s migrations | remote: %s recorded\n' "${local_count}" "${remote_count}"

check_a_ok=1
if [ -n "${missing_on_remote}" ]; then
  check_a_ok=0
  warn "Migrations present locally but NOT recorded on the target:"
  printf '      %s\n' ${missing_on_remote}
fi
if [ -n "${extra_on_remote}" ]; then
  check_a_ok=0
  warn "Migrations recorded on the target but absent from this branch:"
  printf '      %s\n' ${extra_on_remote}
  warn "Someone deployed a schema this branch does not contain. Rebase before shipping."
fi

# ---------------------------------------------------------------------------
# Check B — deployed schema shape vs the columns the client selects
# ---------------------------------------------------------------------------
log "Check B: deployed schema shape"

# Terminator is /^\]/ and NOT /^\];/. The array is declared as
#   const VIEW_COLUMNS = [ ... ].join(", ");
# so a /^\];/ range never closes, runs on to the next ']; ' anywhere in the file,
# and silently harvests unrelated string literals — measured at 49 "columns"
# including 'eq', 'from' and 'success'. Requiring the bare bracket keeps this
# list exactly equal to the real select list.
required_columns="$(sed -n '/^const VIEW_COLUMNS = \[/,/^\]/p' "${CLIENT_FEED}" \
  | grep -oE '"[a-z_0-9]+"' | tr -d '"' | sort -u)"

if [ -z "${required_columns}" ]; then
  fail "Could not extract VIEW_COLUMNS from ${CLIENT_FEED}.
     The gate cannot derive the required schema, so it cannot verify anything.
     Fix the extraction rather than removing the check."
fi
printf '    %s columns required by the feed select list\n' "$(printf '%s\n' "${required_columns}" | grep -c .)"

check_b_ok=1

for relation in ${VIEW_RELATIONS}; do
  if ! deployed_columns="$(remote_query "select column_name from information_schema.columns where table_schema = 'public' and table_name = '${relation}' order by column_name;" 2>&1)"; then
    fail "Could not read columns for public.${relation}.
--- psql said ---
${deployed_columns}"
  fi
  deployed_columns="$(printf '%s\n' "${deployed_columns}" | tr -d '\r' | grep -E '^[a-z_0-9]+$' | sort -u || true)"

  if [ -z "${deployed_columns}" ]; then
    check_b_ok=0
    warn "public.${relation} does not exist on the target."
    continue
  fi

  absent="$(comm -23 <(printf '%s\n' "${required_columns}") <(printf '%s\n' "${deployed_columns}") || true)"
  if [ -n "${absent}" ]; then
    check_b_ok=0
    warn "public.${relation} is missing columns the deployed client selects:"
    printf '      %s\n' ${absent}
  else
    printf '    public.%s exposes all required columns\n' "${relation}"
  fi
done

for table in ${REQUIRED_TABLES}; do
  if ! present="$(remote_query "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name = '${table}';" 2>&1)"; then
    fail "Could not check public.${table}.
--- psql said ---
${present}"
  fi
  if ! printf '%s\n' "${present}" | tr -d '\r' | grep -qx "${table}"; then
    check_b_ok=0
    warn "public.${table} does not exist on the target."
  fi
done

# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------
if [ "${check_a_ok}" -ne 1 ] || [ "${check_b_ok}" -ne 1 ]; then
  fail "SCHEMA PREFLIGHT FAILED — refusing to deploy.
     A service whose code expects columns the database does not have is exactly
     how the 2026-10 Find Jobs outage shipped: history said 'applied', the feed
     said 'could not load'.
     Repair the target (apply the missing migrations, then RECREATE any view that
     was built before a column it now depends on existed — CREATE OR REPLACE VIEW
     does not refresh a frozen 'o.*' column list), then re-run."
fi

log "Schema preflight passed: history and shape both match ${local_count} local migrations."
