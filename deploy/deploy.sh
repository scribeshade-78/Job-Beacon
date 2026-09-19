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
#   4. Rebuild and restart with "docker compose ... up -d --build". Compose
#      replaces the container in place, so the downtime is the image build plus
#      one container start, not a manual stop/wait/start sequence.
#   5. Smoke test /api/health until it answers, and FAIL LOUDLY if it never does.
#      A deploy that reports success while the app is down is worse than one that
#      reports failure, because nobody looks.
#
# SECRETS NEVER LEAVE THIS MACHINE. The tarball excludes .env and .env.* — the
# VPS has its own .env.production, placed there by hand. Shipping the local .env
# would push a development service-role key and a development WORKER_TRIGGER_SECRET
# onto a production host.

set -euo pipefail

# ---- configuration ----------------------------------------------------------
# Override by exporting before running, e.g.
#   VPS_HOST=1.2.3.4 SSH_KEY=~/.ssh/deploy ./deploy/deploy.sh
VPS_USER="${VPS_USER:-root}"
VPS_HOST="${VPS_HOST:-}"
SSH_KEY="${SSH_KEY:-}"
REMOTE_DIR="${REMOTE_DIR:-/opt/jobbeacon}"
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
if tar -tzf "${ARCHIVE_NAME}" | grep -qE '(^|/)\.env($|\.)' | grep -qv '\.env\.example'; then
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

  docker compose -f '${COMPOSE_FILE}' up -d --build
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
