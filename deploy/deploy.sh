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
APP_CONTAINER="${APP_CONTAINER:-jobbeacon-app}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:5000/api/health}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"
HEALTH_DELAY_SECONDS="${HEALTH_DELAY_SECONDS:-5}"
# SEPARATE FROM HEALTH_URL ON PURPOSE, AND ON BY DEFAULT. HEALTH_URL polls the
# host's own loopback, which proves only that the container is up — a deploy that
# left Traefik with no router for the domain still reported success while every
# real visitor got a 404. Set PUBLIC_HEALTH_URL= (empty) to skip the check.
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL-https://jobbeacon.in/api/health}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE_NAME="jobbeacon-deploy.tar.gz"
# The local archive lives OUTSIDE the repository: see the packaging stage for why
# that placement is required rather than cosmetic.
ARCHIVE_PATH="$(mktemp -d)/${ARCHIVE_NAME}"

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
#
# *.txt is excluded for the same reason, and was added after finding an untracked
# "chatgpt api key.txt" in the repository root: it is git-ignored, so nothing
# else would have stopped it being tarred, uploaded to the VPS and left there.
# It is not the only one either — docker-compose.yml.txt is a stray copy and
# docs/sample-emails/interview.txt is a manual-test fixture. None is read at
# build or run time, so excluding the whole extension costs nothing.
#
# THE .env PATTERNS ARE LISTED TWICE ON PURPOSE, and the pairs are not
# redundant. tar stores members as "./path" when handed ".", so the "./" forms
# match the repository ROOT and nothing else — a .env inside a subdirectory
# (a nested worktree under .kilo, say) matched neither and relied entirely on
# the assertion below to stop the deploy. The bare forms cover any depth.
# A leaked .env is a service-role key on a production host, so both are kept.
#
# .kilo is a local worktree directory: a second checkout of this repository,
# complete with its own docs, Dockerfile and env templates. Shipping it would
# bloat the upload and put a parallel copy of the source on the VPS.
# THE ARCHIVE IS WRITTEN OUTSIDE THE REPOSITORY, and that placement is
# load-bearing rather than tidiness. Writing it into the tree it is archiving
# makes GNU tar see "." change while it is still reading it and exit 1 — and
# under set -e that aborted the deploy right here, before anything was uploaded,
# leaving a complete-looking archive behind and no explanation in the log.
#
# The obvious fix, --warning=no-file-changed, DOES NOT WORK: it suppresses the
# message but tar still returns 1. That was measured on this repository with
# GNU tar 1.35 and a 1.8 MB archive. Keeping the archive out of the tree removes
# the cause instead of muting the symptom.
tar -czf "${ARCHIVE_PATH}" \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./.git' \
  --exclude='./.kilo' \
  --exclude='./.env' \
  --exclude='./.env.*' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='*/.env' \
  --exclude='*/.env.*' \
  --exclude='*.txt' \
  --exclude="./${ARCHIVE_NAME}" \
  --exclude='./coverage' \
  --exclude='./supabase/.temp' \
  .

# Prove the exclusion rather than trusting it: if any env file made it in, stop.
# The two committed *.example templates are the only permitted matches — they
# carry no values. .env.build is deliberately NOT shipped, same as
# .env.production: the VPS holds its own copy, placed by hand.
if tar -tzf "${ARCHIVE_PATH}" | grep -qE '(^|/)\.env($|\.)' | grep -qvE '\.env\.example$|\.env\.build\.example$'; then
  rm -f "${ARCHIVE_PATH}"
  fail "Refusing to deploy: the archive contains a .env file. This is a bug in deploy.sh."
fi

# Same reasoning as the .env check above: prove the exclusion rather than
# trusting the flag, because a pattern typo would otherwise ship untracked local
# files silently. Nothing the build or the server reads ends in .txt.
if tar -tzf "${ARCHIVE_PATH}" | grep -qE '\.txt$'; then
  rm -f "${ARCHIVE_PATH}"
  fail "Refusing to deploy: the archive contains a .txt file. This is a bug in deploy.sh."
fi

# ---- 3. upload ---------------------------------------------------------------
log "Ensuring ${REMOTE_DIR} exists on ${REMOTE}"
ssh "${SSH_OPTS[@]}" "${REMOTE}" "mkdir -p '${REMOTE_DIR}'"

log "Uploading ${ARCHIVE_NAME} to ${REMOTE}:${REMOTE_DIR}"
scp "${SCP_OPTS[@]}" "${ARCHIVE_PATH}" "${REMOTE}:${REMOTE_DIR}/${ARCHIVE_NAME}"

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

# ---- 6. public health ---------------------------------------------------------
# THE LOOPBACK CHECK ABOVE CANNOT SEE A ROUTING FAILURE, and that is not
# hypothetical: the container was healthy on 127.0.0.1:5000 while jobbeacon.in
# answered with Traefik's own 404, because the app had no Traefik router. A
# deploy must not report success in that state.
if [ -n "${PUBLIC_HEALTH_URL}" ]; then
  log "Verifying public routing at ${PUBLIC_HEALTH_URL}"
  public_attempt=1
  until ssh "${SSH_OPTS[@]}" "${REMOTE}" "curl -fsS -o /dev/null '${PUBLIC_HEALTH_URL}'" 2>/dev/null; do
    if [ "${public_attempt}" -ge "${HEALTH_ATTEMPTS}" ]; then
      printf '\n'
      fail "The container is healthy but ${PUBLIC_HEALTH_URL} never answered.
     This is a ROUTING failure, not an application failure. Check that the app
     service still carries its Traefik labels and joined the proxy network:
     ssh ${REMOTE} 'docker inspect ${APP_CONTAINER} --format {{json .Config.Labels}}'
     ssh ${REMOTE} 'docker network inspect traefik-proxy --format {{range .Containers}}{{.Name}} {{end}}'"
    fi
    printf '.'
    public_attempt=$((public_attempt + 1))
    sleep "${HEALTH_DELAY_SECONDS}"
  done
fi

rm -f "${ARCHIVE_PATH}"
rmdir "$(dirname "${ARCHIVE_PATH}")" 2>/dev/null || true
log "Deployed. ${HEALTH_URL} is healthy and ${PUBLIC_HEALTH_URL} answers."
