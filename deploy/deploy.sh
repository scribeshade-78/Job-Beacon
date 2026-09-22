#!/usr/bin/env bash
#
# Task J — deploy JobBeacon to the VPS.
#
#   ./deploy/deploy.sh
#
# Five stages, ordered so that the cheapest failure happens first:
#
#   1. Sanity-build locally. A TypeScript error stops the deploy here, on the
#      machine where it can be read, instead of mid-way through a remote rebuild.
#   2. Package the SOURCE into a tarball. The image is built on the VPS rather
#      than shipped as a saved image: the developer machine is Windows/amd64 and
#      the VPS is Linux, and moving a built image between them is a
#      platform-matching problem with no upside when the VPS can build it.
#   3. Upload over SSH.
#   4. Rebuild and restart with "docker compose --env-file .env.build ... up -d
#      --build". Compose replaces the container in place, so the downtime is the
#      image build plus one container start, not a manual stop/wait/start
#      sequence. The --env-file is what supplies the VITE_* BUILD ARGS — a
#      service's env_file: does not feed build.args, and omitting it here is
#      precisely what produced the blank-white-page outage.
#   5. Smoke test /api/health until it answers, and FAIL LOUDLY if it never does.
#      A deploy that reports success while the app is down is worse than one that
#      reports failure, because nobody looks.
#
# SECRETS NEVER LEAVE THIS MACHINE. The tarball excludes .env and .env.* — the
# VPS has its own .env.production (runtime secrets) and its own .env.build (the
# two public VITE_* build args), both placed there by hand. Shipping the local
# .env would push a development service-role key and a development
# WORKER_TRIGGER_SECRET onto a production host.

set -euo pipefail

# ---- configuration ----------------------------------------------------------
# Override by exporting before running, e.g.
#   VPS_HOST=1.2.3.4 SSH_KEY=~/.ssh/deploy ./deploy/deploy.sh
VPS_USER="${VPS_USER:-root}"
VPS_HOST="187.127.138.151"
SSH_KEY="${SSH_KEY:-}"
REMOTE_DIR="/root/jobbeacon"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:5000/api/health}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"
HEALTH_DELAY_SECONDS="${HEALTH_DELAY_SECONDS:-5}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE_NAME="jobbeacon-deploy.tar.gz"

log()  { printf '\n==> %s\n' "$*"; }
fail() { printf '\n!! %s\n' "$*" >&2; exit 1; }

if [ -z "${VPS_HOST}" ]; then
  fail "VPS_HOST is not set. Export it (and usually SSH_KEY) before running:
     VPS_HOST=<host> SSH_KEY=<path-to-key> ./deploy/deploy.sh"
fi

SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
SCP_OPTS=(-o StrictHostKeyChecking=accept-new)
if [ -n "${SSH_KEY}" ]; then
  [ -f "${SSH_KEY}" ] || fail "SSH_KEY does not exist: ${SSH_KEY}"
  SSH_OPTS+=(-i "${SSH_KEY}")
  SCP_OPTS+=(-i "${SSH_KEY}")
fi
REMOTE="${VPS_USER}@${VPS_HOST}"

# ---- 1. sanity build ---------------------------------------------------------
cd "${REPO_ROOT}"
log "Building locally to fail fast on a compile error"
npm run build

# Assert the bundle actually carries Supabase config. This is the regression
# guard for the blank-white-page outage: a Vite build with no VITE_* env vars
# SUCCEEDS — it just produces a bundle that throws during its first render and
# renders nothing — so a green build is not evidence that the client works.
# Checked here, on the machine where the cause is readable, rather than
# discovering it from a user-facing blank page.
log "Asserting the built client contains Supabase configuration"
BUILD_URL_VALUE="$(sed -n 's/^VITE_SUPABASE_URL=//p' .env 2>/dev/null | tail -n 1 | tr -d '\r')"
if [ -z "${BUILD_URL_VALUE}" ]; then
  fail ".env has no VITE_SUPABASE_URL. Add it (and VITE_SUPABASE_PUBLISHABLE_KEY) before deploying — without them the client bundle renders a blank white page."
fi
if ! grep -rqF -- "${BUILD_URL_VALUE}" dist/client/assets/; then
  fail "dist/client was built WITHOUT VITE_SUPABASE_URL inlined. Shipping this bundle produces a blank white page. Check .env and vite.config.ts's envDir."
fi

# ---- 2. package --------------------------------------------------------------
log "Packaging source into ${ARCHIVE_NAME}"
# --exclude of .env* is a security control, not tidiness. See the header.
tar -czf "${ARCHIVE_NAME}" \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./.git' \
  --exclude='./.env' \
  --exclude='./.env.*' \
  --exclude="./${ARCHIVE_NAME}" \
  --exclude='./coverage' \
  --exclude='./supabase/.temp' \
  .

# Prove the exclusion rather than trusting it: if any env file made it in, stop.
# The two committed *.example templates are the only permitted matches — they
# carry no values. .env.build is deliberately NOT shipped, same as
# .env.production: the VPS holds its own copy, placed by hand.
if tar -tzf "${ARCHIVE_NAME}" | grep -qE '(^|/)\.env($|\.)' | grep -qvE '\.env\.example$|\.env\.build\.example$'; then
  rm -f "${ARCHIVE_NAME}"
  fail "Refusing to deploy: the archive contains a .env file. This is a bug in deploy.sh."
fi

# ---- 3. upload ---------------------------------------------------------------
log "Ensuring ${REMOTE_DIR} exists on ${REMOTE}"
ssh "${SSH_OPTS[@]}" "${REMOTE}" "mkdir -p '${REMOTE_DIR}'"

log "Uploading ${ARCHIVE_NAME} to ${REMOTE}:${REMOTE_DIR}"
scp "${SCP_OPTS[@]}" "${ARCHIVE_NAME}" "${REMOTE}:${REMOTE_DIR}/${ARCHIVE_NAME}"

# ---- 4. rebuild and restart --------------------------------------------------
log "Rebuilding and restarting the container"
ssh "${SSH_OPTS[@]}" "${REMOTE}" "
  set -euo pipefail
  cd '${REMOTE_DIR}'
  tar -xzf '${ARCHIVE_NAME}'
  rm -f '${ARCHIVE_NAME}'

  if [ ! -f .env.production ]; then
    echo 'Missing .env.production in ${REMOTE_DIR}.' >&2
    echo 'Create it from .env.example before deploying — the app reads SUPABASE_URL,' >&2
    echo 'SUPABASE_SERVICE_ROLE_KEY and the rest from it at runtime.' >&2
    exit 1
  fi

  # .env.build is a SECOND, BUILD-TIME file and it is not redundant. Vite
  # inlines VITE_* into the bundle while it compiles, so compose's runtime
  # env_file cannot configure the client — the build needs these two values as
  # build args, and build args are resolved from --env-file, not from env_file.
  # It holds ONLY the two public values; the service-role key stays in
  # .env.production and must never be named VITE_* or passed as a build arg.
  if [ ! -f .env.build ]; then
    echo 'Missing .env.build in ${REMOTE_DIR}.' >&2
    echo 'It must contain exactly these two lines (values copied from .env.production):' >&2
    echo '  VITE_SUPABASE_URL=...' >&2
    echo '  VITE_SUPABASE_PUBLISHABLE_KEY=...' >&2
    echo 'Without it the client bundle builds with no Supabase config and the' >&2
    echo 'site serves a blank white page.' >&2
    exit 1
  fi

  docker compose --env-file .env.build -f '${COMPOSE_FILE}' up -d --build
  docker image prune -f >/dev/null 2>&1 || true
"

# ---- 5. smoke test -----------------------------------------------------------
log "Waiting for ${HEALTH_URL} to answer (up to $((HEALTH_ATTEMPTS * HEALTH_DELAY_SECONDS))s)"
attempt=1
until ssh "${SSH_OPTS[@]}" "${REMOTE}" "curl -fsS -o /dev/null '${HEALTH_URL}'" 2>/dev/null; do
  if [ "${attempt}" -ge "${HEALTH_ATTEMPTS}" ]; then
    printf '\n'
    fail "The container never became healthy. Inspect it with:
     ssh ${REMOTE} 'cd ${REMOTE_DIR} && docker compose -f ${COMPOSE_FILE} logs --tail=100 app'"
  fi
  printf '.'
  attempt=$((attempt + 1))
  sleep "${HEALTH_DELAY_SECONDS}"
done

rm -f "${ARCHIVE_NAME}"
log "Deployed. ${HEALTH_URL} is healthy."
