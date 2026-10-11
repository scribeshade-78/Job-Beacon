#!/usr/bin/env bash
#
# Brief 3 - assert the RUNNING environment, after boot.
#
# WHY THIS IS SEPARATE FROM THE HEALTH POLL. deploy.sh already waits for
# /api/health to answer, but "a process is up" and "the process is running the
# artefact and the configuration we just deployed" are different claims. The gap
# between them is exactly how a container kept serving the PREVIOUS environment
# while a deploy reported success.
#
# A STANDALONE SCRIPT, like preflight-schema.sh, so it can be run on its own and
# made to FAIL DELIBERATELY. A gate nobody has seen fail is a gate nobody knows
# works.
#
# usage: assert-environment.sh <expected-commit> [health-url]
#   ENV_ASSERT_SSH=root@host   read the URL over ssh instead of locally
#
# exit 0 = the running artefact and environment match what was deployed
# exit 1 = they do not
# exit 2 = misused
set -u

EXPECTED_COMMIT="${1:-}"
HEALTH_URL="${2:-http://127.0.0.1:5000/api/health}"
REMOTE="${ENV_ASSERT_SSH:-}"

if [ -z "${EXPECTED_COMMIT}" ]; then
  echo "usage: assert-environment.sh <expected-commit> [health-url]" >&2
  exit 2
fi

fail() {
  echo "!! $*" >&2
  exit 1
}

if [ -n "${REMOTE}" ]; then
  body="$(ssh -o BatchMode=yes "${REMOTE}" "curl -fsS '${HEALTH_URL}'" 2>/dev/null)" \
    || fail "Could not read ${HEALTH_URL} on ${REMOTE}."
else
  body="$(curl -fsS "${HEALTH_URL}" 2>/dev/null)" || fail "Could not read ${HEALTH_URL}."
fi

[ -n "${body}" ] || fail "${HEALTH_URL} returned an empty body."

# One JSON field, dotted path. Node rather than jq because the deploy runs from a
# checkout that already requires node, and jq is not guaranteed on either host.
field() {
  printf '%s' "${body}" | node -e '
    let raw = "";
    process.stdin.on("data", (c) => { raw += c; });
    process.stdin.on("end", () => {
      try {
        const value = process.argv[1]
          .split(".")
          .reduce((node, key) => (node == null ? undefined : node[key]), JSON.parse(raw));
        process.stdout.write(
          Array.isArray(value) ? value.join(",") : value === undefined || value === null ? "" : String(value),
        );
      } catch {
        process.stdout.write("");
      }
    });
  ' "$1"
}

commit="$(field version.commit)"
env_ok="$(field environment.ok)"
required_missing="$(field environment.requiredMissing)"
optional_missing="$(field environment.optionalMissing)"
dependency="$(field dependencies.supabase)"
deployed_at="$(field version.deployedAt)"

echo "    reported commit:     ${commit}"
echo "    deployed at:         ${deployed_at:-unknown}"
echo "    environment ok:      ${env_ok:-<unreadable>}"
echo "    supabase dependency: ${dependency:-<unreadable>}"

[ -n "${env_ok}" ] || fail "${HEALTH_URL} did not return the Brief 3 payload.
     The container is running an image built BEFORE the environment assertion
     existed, or a different service is answering on that port."

# "unknown" IS NO CLAIM, NOT A MISMATCH. A local 'docker compose up' with no build
# args legitimately cannot know its commit; failing that would break local runs for
# a reason that has nothing to do with the deployed artefact.
if [ "${commit}" = "unknown" ]; then
  echo "    !! commit is 'unknown' - no artefact claim to check (build args were not passed)"
elif [ "${commit}" != "${EXPECTED_COMMIT}" ]; then
  fail "The container is answering but reports commit '${commit}', not '${EXPECTED_COMMIT}'.
     It is serving the PREVIOUS build. This is the failure that looks like success:
     the site works, and it is the wrong code.
     ssh ${REMOTE:-localhost} 'cd /root/jobbeacon && docker compose -f docker-compose.prod.yml logs --tail=50 app'"
fi

if [ "${env_ok}" != "true" ]; then
  fail "The container is up but its REQUIRED environment is incomplete.
     Missing: ${required_missing}
     Present-but-empty counts as absent, so check for bare 'NAME=' lines."
fi

if [ "${dependency}" != "ok" ]; then
  fail "The container cannot reach Supabase ('${dependency}').
     The service-role key may be present but invalid, or the URL unreachable from
     the container. Presence is not permission."
fi

if [ -n "${optional_missing}" ]; then
  # Loud, not fatal: a disabled feature is a decision, an omitted required key is a
  # fault. Saying which is which is the whole point of the split.
  echo "    !! optional, not configured (features disabled): ${optional_missing}"
fi

echo "    environment assertion passed: commit ${commit}, required keys present, supabase reachable"
