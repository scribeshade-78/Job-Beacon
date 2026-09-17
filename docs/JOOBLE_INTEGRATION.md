# Jooble integration — obtaining and wiring `JOOBLE_API_KEY`

Jooble is an aggregator-tier discovery source (the same class as Adzuna and
USAJOBS, not an employer-hosted ATS board like Greenhouse/Lever). This
document is the operator runbook **and** the design record: it covers getting a
key, proving it works, storing it in each environment, the adapter that
consumes it, and the security rules that follow from one unusual provider
detail.

## 0. Status — what is already built, and what only you can do

```text
DONE IN THIS REPO (code, tests, config)
  server/ingestion/adapters/jooble.ts              adapter: pagination, pacing,
                                                   retries, quota guard, redaction
  server/ingestion/adapters/jooble.test.ts         42 tests (all passing)
  server/ingestion/joobleSmoke.ts                  one-request live acceptance check
  server/ingestion/adapters/registry.ts            adapter registered as "jooble"
  server/ingestion/adapters/registry.test.ts       source-count assertion updated
  server/opportunities/jdExtraction.ts             jooble JD extractor added
  server/opportunities/jdExtraction.test.ts        extractor test added
  .env.example                                     JOOBLE_API_KEY entry + warnings
  package.json                                     npm run jooble:smoke
  supabase/migrations/20260902000000_jooble_source_policy.sql
                                                  source_policies row for "jooble"

REQUIRES A HUMAN (see the sections noted)
  1. Register on the Jooble portal and copy the key       -> §1
  2. Verify the key by hand                               -> §2
  3. Store it per environment                             -> §3
  4. Apply the migration and seed a polled target         -> §10 phase B
  5. Confirm Jooble's API terms before public display     -> §9
```

Everything in the first block is real, committed-shape code: the test suite
passes and the typecheck is clean. Nothing in the second block can be done
from inside this repository, because it all needs a real credential that no
tool should generate or guess.

---

## 1. Obtaining the key

### 1.1 Choose the country domain FIRST

This is the step people skip, and it is the one that cannot be undone by
editing config later. **A Jooble key is scoped to one country domain and
returns only that country's listings.** Jooble's own documentation is explicit:

> Each Jooble domain (country) requires its own unique REST API key. For
> instance, a key generated on jooble.org provides access exclusively to US job
> listings. To query vacancies for other countries, register and obtain an API
> key on the corresponding regional domain (e.g. uk.jooble.org/api/about for
> the UK or de.jooble.org/api/about for Germany).

| Target market | Registration page |
| --- | --- |
| United States | `https://jooble.org/api/about` |
| United Kingdom | `https://uk.jooble.org/api/about` |
| Germany | `https://de.jooble.org/api/about` |
| Other markets | `https://<country-code>.jooble.org/api/about` — the pattern is consistent, but confirm the exact domain for your market on the Jooble site rather than assuming the code |

A key used against the wrong domain fails with **HTTP 403**, not with empty
results — so a mismatch looks like a broken key rather than a wrong domain.
Write down which domain you registered on; you will need it twice more (the
`country` field of the polled target, and any later 403 investigation).

### 1.2 Register

1. Open the registration page for your chosen domain from the table above.
2. Complete the account registration and accept Jooble's API Terms of Use
   (they are linked from that page and from the REST API documentation).
3. Copy the API key the portal generates. Jooble's guide is "complete the
   registration to generate your unique API key" — there is no separate
   approval step documented.
4. Store it immediately in a password manager or your secrets manager
   (§3). Do not park it in a note, a chat message, a ticket, or a screenshot.
5. Record two facts alongside it, because they are not stored in the key:
   - **the domain it was issued on** (which country it covers), and
   - **the date you got it** (useful for a rotation log).

### 1.3 Understand the quota before you write a single request

The free REST API plan is a **lifetime total of 500 requests per key**. It is
not monthly and it does not reset. Jooble's documentation states it directly:
"a total lifetime limit of 500 requests per key (this is an absolute lifetime
quota, not a monthly limit)".

That single sentence drives most of the adapter's design (§4) and all of the
runbook discipline below:

- **A retry is not free.** It is a request spent. The adapter therefore retries
  only genuinely transient failures, never a 403 or a 404.
- **Every pagination step is a request.** Page size is the cheap lever:
  `ResultOnPage` is paid for once per page, so one large page beats five
  small ones.
- **Manual testing spends the same budget as production.** Each `curl`
  call in §2 costs one request out of 500, forever.
- **A leaked key is worse than a leaked credential elsewhere** — an attacker
  does not just read data, they burn an allowance you cannot refill.

### 1.4 One question worth asking Jooble support

The quota is **per key**, and each key is per country domain. It is **not
documented** whether one account may hold several keys for the same domain.
This matters because a single shared key means local development, CI, and
production all draw down the same non-renewable 500-request allowance.

Until that is confirmed, treat the production key as the only key and do not
point local development at it. See §3.2.

---

## 2. Verifying the key by hand

Do this **once**, before any code is wired up. It costs one request.

### 2.1 The request Jooble documents

```http
POST https://jooble.org/api/{API_KEY}
Content-Type: application/json

{
  "keywords": "Sales Manager, Administrator",
  "location": "Kyiv",
  "radius": "80",
  "page": "1",
  "companysearch": "false"
}
```

Both `keywords` and `location` are required by the API. This is the
exact payload from Jooble's documentation, string values and all — see §4.3 for
why this adapter sends strings even though the parameter table says otherwise.

### 2.2 Bash / Git Bash / WSL

```bash
# Read the key from the environment so it never lands in shell history or in a
# pasted command. Use a throwaway shell session, then close it.
export JOOBLE_API_KEY=your_key_here

curl -sS -X POST "https://jooble.org/api/$JOOBLE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"keywords":"Sales Manager","location":"Kyiv","radius":"80","page":"1","companysearch":"false"}'
```

### 2.3 PowerShell (Windows)

```powershell
$env:JOOBLE_API_KEY = "your_key_here"

$body = @{
  keywords     = "Sales Manager"
  location     = "Kyiv"
  radius       = "80"
  page         = "1"
  companysearch = "false"
} | ConvertTo-Json

Invoke-RestMethod -Method Post \
  -Uri "https://jooble.org/api/$env:JOOBLE_API_KEY" \
  -ContentType 'application/json' \
  -Body $body | ConvertTo-Json -Depth 5
```

When finished, clear it from the session:

```powershell
Remove-Item Env:\JOOBLE_API_KEY
```

### 2.4 What a working response looks like

```json
{
  "totalCount": 1,
  "jobs": [
    {
      "id": 1234567890,
      "title": "Sales Manager",
      "location": "Kyiv",
      "snippet": "This is a great opportunity to join our team...",
      "salary": "17,600 UAH",
      "source": "jooble",
      "type": "Full-time",
      "link": "https://ua.jooble.org/jdp/12345",
      "company": "ABC Corp",
      "updated": "2023-09-15T12:55:35.3870000"
    }
  ]
}
```

Note `updated`: seven fractional digits. That is what Jooble sends. The
adapter passes it through verbatim rather than reformatting it (§5).

### 2.5 Reading the failure codes

| Response | Meaning | What to do |
| --- | --- | --- |
| **200** with `jobs` | Working | Proceed to §3 |
| **200** with `totalCount: 0` | Working, but no matches | Try a broader `keywords`/`location`. The key is fine — do not rotate it |
| **403** | Access denied | The key is wrong, revoked, **or issued for a different country domain than the URL you called**. Check the domain from §1.1 first — this is the most common cause |
| **404** | Not found | The key is malformed or truncated. Re-copy it from the portal in full |

### 2.6 Hygiene rules for this test — the key is IN the URL

Because the credential lives in the request **path**, the usual "don't print
the Authorization header" instinct does not protect you here:

- **Never use `curl -v` / `--verbose`.** It prints the full request
  line, which contains the key. Use `-sS`.
- **Never paste the key inline in a command** you might share, screenshot, or
  that lands in shell history. Use the environment variable form above.
- **Clear history afterwards** if you did paste it: on PowerShell,
  `Clear-History`; in bash, remove the line from `~/.bash_history`.
- **In Postman**, put the key in an environment/collection variable named
  `jooble_api_key` and mark it **secret**; the URL becomes
  `https://jooble.org/api/{{jooble_api_key}}`. But be aware that the
  **Postman Console prints the resolved URL**, and environment secrets sync to
  Postman's cloud if you are signed in. Close the console before sending, and
  prefer a local (not synced) environment for this one.
- **A teammate does not need your key to test.** They need their own
  registration, or your permission to spend one of your 500 requests.

---

## 3. Where the key lives

### 3.1 The three environments at a glance

| Environment | Where the value goes | Loaded by | Notes |
| --- | --- | --- | --- |
| Local dev | `.env` in the repo root (already git-ignored) | `npm run dev:server` via `--env-file-if-exists=.env`; Vitest loads it via Vite | Never a `VITE_` name — see §3.4 |
| n8n (as scheduler) | n8n's own process environment; n8n never needs to see it | — | Preferred: n8n triggers JobBeacon, which does the calling (§3.3) |
| n8n (as caller) | n8n credential or `{{\$env.JOOBLE_API_KEY}}` | n8n's container/host env | Only if n8n itself calls Jooble. Read the leak warnings in §3.3 first |
| Production | Secrets manager, injected as an environment variable at runtime | The process supervisor / platform | Never baked into an image or a committed config file (§3.5) |

### 3.2 Local development

The repository already ignores `.env` — verified, not assumed:

```bash
git check-ignore -v .env
# .gitignore:3:.env        .env
```

`.gitignore` contains `.env`, `.env.*`, and an explicit
`!.env.example` un-ignore. So a local `.env` — and even a stray
`.env.bak` — cannot be committed by accident. Add your line to `.env`:

```bash
# .env — NEVER commit this file (it is git-ignored already)
JOOBLE_API_KEY=your_key_here
```

Two rules for this key specifically:

1. **Only use the production key locally if you accept spending the shared
   allowance.** Prefer not to. If Jooble confirms that one account can hold
   several keys for a domain (§1.4), register a second key for development and
   use that one here.
2. **Never point local development at production data.** Running the adapter
   against a copy of the production `vacancy_sources` table would spend
   the production key's quota on your laptop.

### 3.3 n8n

There are **no n8n artifacts in this repository** — the ingestion fanout is
external. That shapes the recommendation.

**Preferred: n8n schedules, JobBeacon calls.** n8n triggers the batch endpoint
with the worker secret, and the adapter on the server does the Jooble call:

```text
POST https://<jobbeacon-host>/api/worker/run
Authorization: Bearer <WORKER_TRIGGER_SECRET>
```

In this arrangement **n8n never handles the Jooble key at all**, which removes
the entire class of leak described below. This is why it is preferred: it keeps
the credential in exactly one place, the server's environment.

**Only if n8n must call Jooble directly**, use one of these, in this order:

1. **An n8n credential** (HTTP Request node → Generic Credential Type → Header
   Auth is **not usable here**, because Jooble authenticates via the URL path,
   not a header). Practically this means either the `\$env` form below or
   a community credential node.
2. **n8n's environment variable, referenced as an expression.** Set
   `JOOBLE_API_KEY` in n8n's own process environment (its
   docker-compose/service environment, or n8n's `.env` — *not*
   JobBeacon's), then set the node URL to:

   ```text
   https://jooble.org/api/{{ $env.JOOBLE_API_KEY }}
   ```

   n8n stores the **expression text**, not the resolved value, in the workflow
   JSON — so the workflow file stays safe to export and share.

**The trap to avoid: pasting the literal key into the node URL field.** n8n
persists node parameters as part of the workflow, so a literal key there is
written into every workflow export, every workflow backup, and the n8n
database — and because n8n also records execution data, the resolved URL can
appear in an execution record too. If you must use a literal, then at minimum:

- disable execution data retention for that workflow (Settings → *Save
  successful production executions* = **Do not save**), and
- set `EXECUTIONS_DATA_PRUNE=true` with a short
  `EXECUTIONS_DATA_MAX_AGE` so old records are not kept indefinitely, and
- restrict who can view executions in n8n, treating them as secret material.

Also note that n8n's **error workflow and node error output** can include the
request URL. Scrub it the same way §7 describes.

### 3.4 Server-only, always — never `VITE_`

`server/ingestion/adapters/jooble.ts` is server/worker code. Two rules
that the rest of this repo already follows and that apply unchanged here:

- **Never name it `VITE_JOOBLE_API_KEY`.** Vite inlines every
  `VITE_*` variable into the browser bundle, which would publish the key
  to every visitor.
- **Never import `jooble.ts` (or anything that imports it) from
  `client/src`.** The adapter reads `process.env` directly, which
  does not exist in the browser.

### 3.5 Production

Store the key in a secrets manager and inject it as an environment variable at
runtime. Any of these fit this stack; pick whichever the deployment already
uses rather than introducing a new one:

- **Doppler / Infisical** — simplest for a Node service plus external workers;
  both support per-environment values and rotation.
- **AWS Secrets Manager / GCP Secret Manager / Azure Key Vault** — right choice
  if the deployment already lives there.
- **Supabase** — Supabase Vault or Edge Function secrets work if the ingestion
  worker runs inside Supabase's runtime; **do not** store the key in a table
  and read it at runtime, because table contents are queryable by anything
  holding a service-role key and are far easier to leak than a secret store.
- **Platform env vars** (Fly.io secrets, Render, Railway, Coolify) — acceptable,
  provided access is limited and the value is never printed by a deploy log.

Production rules:

- The key must **not** appear in an image layer, a build artifact, a
  `Dockerfile` `ENV` line, or a committed `docker-compose.yml`.
- Deploy logs must not echo the environment. Several platforms print env vars
  at debug level — check before trusting one.
- Use a **different** key for production than for development, if §1.4 allows it.
- Grant read access to as few people and systems as possible; the key has no
  scopes, so possession is full possession.

---

## 4. The ingestion adapter

`server/ingestion/adapters/jooble.ts`

It implements the repository's existing `DiscoveryAdapter` contract
(`server/ingestion/adapters/types.ts`), so it needs no special handling
anywhere in the pipeline: `worker.ts` resolves it through
`getDiscoveryAdapter("jooble")` exactly like the other four sources.

### 4.1 How it runs

```text
n8n / cron
    -> POST /api/worker/run        (Authorization: Bearer WORKER_TRIGGER_SECRET)
        -> runOneIngestionJob       claims one row from ingestion_jobs
            -> source_policies      must have a "jooble" row, else the job fails
            -> vacancy_sources      supplies target_key + config (keywords, location, ...)
            -> getDiscoveryAdapter("jooble").discover(targetKey, config)
                -> readJoobleCredentials()          reads process.env at call time
                -> discoverJooble(...)              validates, then fetches pages
            -> ingestDiscoveredVacancy  normalizes into vacancies/vacancy_versions
            -> markUnseenVacanciesExpired   freshness sweep (see §4.4)
```

### 4.2 The four behaviours you asked for

**Pagination.** Follows Jooble's documented `page` / `ResultOnPage`
parameters and stops on the first of: an empty page, a short page (fewer jobs
than requested — the last page), `totalCount` reached, or the
`maxPages` budget. Jobs are de-duplicated by `id` across pages,
because result ordering can shift between requests and the same listing can
legitimately appear twice — without de-duplication it would be ingested twice
in one run and counted twice in the freshness sweep.

**Rate limiting.** A minimum interval between sequential requests (default
1.1 s), applied before **every** attempt including retries, so a retry cannot
turn into a burst. A `Retry-After` header on a 429 is honoured, capped at
30 s. **Jooble does not publish a numeric rate limit** — this is a politeness
floor and a burst suppressor, not a documented contract. The real ceiling is
the lifetime quota.

**Retries.** Bounded exponential backoff with jitter, counting each attempt
against the request budget, because each attempt costs quota:

| Outcome | Retried? | Why |
| --- | --- | --- |
| `429`, `500`, `502`, `503`, `504` | Yes, up to `maxRetries` (default 2) | Genuinely transient |
| Transport failure (no HTTP response) | Yes | Same class; already classified before the message is read |
| `403` | **No** | A wrong or wrong-domain key cannot be fixed by asking again. The error names the regional-domain cause explicitly |
| `404` | **No** | Malformed key; retrying burns quota to fail identically |
| Any other 4xx | **No** | A request-shape or config problem. The error names the config fields to check |
| 200 with a non-JSON body | **No** | The same body would come back |
| 200 without a `jobs` array | **No** | Contract mismatch, not a transient one |

**Error handling.** Every failure throws an `Error` whose message is
built only from `REDACTED_JOOBLE_ENDPOINT`. The raw provider error text
and the real URL are never interpolated, and transport-failure messages are
classified and discarded rather than re-thrown, because a fetch
implementation's own message can embed the request URL. `worker.ts`
catches these, records them in `source_health_events`, and applies the
existing job-level retry/backoff and dead-letter behaviour — so the adapter's
retries are the inner loop and the worker's are the outer safety net.

### 4.3 Two design decisions worth knowing about

**Request parameters are sent as strings.** Jooble's parameter table types
`page`/`ResultOnPage`/`SearchMode` as integer and
`companysearch` as boolean, but its own worked example sends all four as
JSON strings (`{"companysearch": "false"}`). This adapter follows the
example, on the reasoning that a worked request is stronger evidence of what
the server accepts than a type column. Documented in the module header so the
next reader does not "fix" it back.

**A partial run is returned, not thrown.** If the request budget or
`maxPages` cuts discovery short, the adapter returns the jobs it did
fetch (so they still ingest) and emits one `console.warn` beginning
`[jooble] partial discovery:`. It never logs a key or URL. This warning
matters because of the next subsection.

### 4.4 Freshness interaction — read before enabling this source

`worker.ts` calls `markUnseenVacanciesExpired()` after every
successful run: **any active vacancy belonging to that
`vacancy_source_id` that this run did not return is marked
`expired`.**

Combine that with Jooble's lifetime quota and a real hazard appears. If a run
fetches only page 1 of a much larger result set, every vacancy that was
discovered from pages 2+ on an earlier run is expired — then re-activated on a
later run, then expired again. Vacancies flap between `active` and
`expired`, candidates see listings disappear and reappear, and trust
scoring sees churn it will interpret as staleness.

Three ways to handle it, in order of preference:

1. **Make one run cover the whole result set** — set `maxPages` and
   `ResultOnPage` so their product exceeds the target's `totalCount`.
   The smoke check in §8.2 prints `totalCount`, so measure it once and
   size the target accordingly. Because `ResultOnPage` is free relative to
   page count, raising page size is almost always the right lever.
2. **Narrow the saved search** so its result set is small enough to cover in
   the budget — more specific `keywords`, a tighter `location`, or a
   `radius`.
3. **Teach the worker to skip the sweep when discovery was truncated** — the
   correct long-term fix, and it needs a small change outside the adapter (a
   "was this run complete?" signal from discovery). Not made here because it
   changes shared pipeline behaviour for all five sources; see §11.

If the `partial discovery` warning appears in the worker log, you are in
this situation. Treat it as a configuration error, not as noise.

### 4.5 Adapter configuration reference

Config is the `config` JSONB column of the `vacancy_sources` row.

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `keywords` | string | *required* | Jooble rejects a search without it. Comma-separated is supported by the API |
| `location` | string | *required* | Jooble rejects a search without it |
| `country` | string | `null` | ISO code written to `vacancies.country`. The response body has **no country field**, so this is the only source for it. Set it to the domain the key was issued on |
| `radius` | string | omitted | Must be one of `0, 4, 8, 16, 26, 40, 80`. Anything else is rejected |
| `salary` | number | omitted | Minimum salary threshold |
| `companySearch` | boolean | `false` | `true` matches keywords against company names |
| `searchMode` | number | omitted | Passed through unchanged |
| `resultsPerPage` | number | `100` | Clamped to 1–100. Jooble documents the parameter but **not its maximum**; 100 is this adapter's own cap |
| `maxPages` | number | `3` | Clamped to 1–10. The hard cap exists so a bad config row cannot drain the quota |
| `minIntervalMs` | number | `1100` | Pacing between requests |
| `maxRetries` | number | `2` | Clamped to 0–5 |
| `retryBaseDelayMs` | number | `1000` | Exponential base; 0 is honoured (tests use it) |
| `maxRequestsPerRun` | number | `6` | Clamped to 1–20. Retries count against it |

Example `vacancy_sources.config` for a small, fully-coverable search:

```json
{
  "keywords": "Sales Manager",
  "location": "United States",
  "country": "US",
  "resultsPerPage": 100,
  "maxPages": 1
}
```

---

## 5. Normalization

`DiscoveredVacancy` (`server/ingestion/types.ts`) is the contract
every adapter normalizes into; `ingest.ts` maps it onto the
`vacancies` table.

| Jooble field | `DiscoveredVacancy` | `vacancies` column | Transformation |
| --- | --- | --- | --- |
| `id` | `sourceVacancyId` | `source_vacancy_id` | Stringified. Used for the dedup key |
| `link` | `authoritativeUrl` | `authoritative_url` | Verbatim. Second dedup key — a match here under a different id is merged as an extra `vacancy_source_records` row instead of a duplicate vacancy |
| `title` | `rawTitle` | `raw_title` | Trimmed; falls back to `"Untitled"` |
| `company` | `companyName` | via `companies.displayed_name` | Trimmed; falls back to `"Unknown"`, matching adzuna.ts |
| `salary` | `salaryMin`/`salaryMax`/`currency` | `salary_min`/`salary_max`/`currency` | Parsed from a formatted **string** — see below |
| `updated` | `publishedAt` | `published_at` | Verbatim, including its 7 fractional digits. Postgres `timestamptz` accepts it; rewriting a provider timestamp would be a silent data edit |
| `snippet` | — | via `vacancy_versions.raw_payload` | No column; preserved in `raw` and read back by the JD extractor (§5.3) |
| `type` | — | via `raw` | Employment type ("Full-time"). `DiscoveredVacancy` has no field for it — a real schema gap, not a mapping oversight |
| `source` | — | via `raw` | The upstream provenance Jooble reports; kept for trust scoring |
| `location` | — | — | **Not decomposed.** See below |
| whole object | `raw` | `vacancy_versions.raw_payload` | Stored verbatim, one row per content change |

### 5.1 Fields deliberately left null, and why

This repository's house rule is that a provider's ambiguity is never resolved
by guessing, and the existing adapters document each such call. The same rule
applied to Jooble's payload leaves four fields null:

- `city` / `region` — Jooble returns one freeform `location`
  string ("Kyiv", "London, UK", "Remote"). Adzuna and USAJOBS have exactly the
  same ambiguity and are handled the same way.
- `remoteType` — Jooble's documented fields contain no remote/hybrid
  indicator. `type` is an *employment* type (Full-time/Part-time), which
  is a different axis; mapping it to `remoteType` would be wrong.
- `salaryInterval` — Jooble never states whether a figure is annual,
  monthly, or hourly. Guessing "year" would silently corrupt every downstream
  salary comparison, so it stays null.
- `companyDomain` — the link points at Jooble or an upstream source,
  never an employer domain, so there is nothing to populate it from.

### 5.2 Salary parsing

Jooble documents `salary` as a **formatted string**, either
`"{min} - {max} {currency}"` or a single value like `"17,600 UAH"`
— never as structured numbers. The parser:

- reads separators with a narrow heuristic: a `,` or `.` counts as
  a thousands separator **only** when it groups digits in exact threes, which is
  what `"17,600"` and `"1.234.567"` do and what `"5,5"` does
  not;
- detects currency from a symbol first, then from a whitelist of ISO codes — the
  whitelist is what stops `"1,000 per month"` from parsing "per" as a
  currency;
- orders two amounts by value, not by print order, so a reversed range still
  yields `min < max`;
- returns nulls for anything unparseable (`"Competitive"`) rather than a
  guess;
- records a single figure as **both** bounds, because Jooble gives no
  lower/upper distinction for one number;
- marks any parsed salary `salarySource: "estimated"` — the same
  conservative call adzuna.ts makes for the same reason: Jooble does not
  document whether the figure is employer-disclosed or its own estimate.

### 5.3 JD extraction (a required, easy-to-miss step)

`extractJd()` in `server/opportunities/jdExtraction.ts` **throws
`UnknownJdSourceError` for any source code it does not know**. Adding the
adapter alone would therefore have left every Jooble vacancy failing JD
extraction in the fit pipeline. A `jooble` extractor was added that maps
`snippet` to a single unheaded section with no HTML snapshot — the same
shape adzuna.ts's `description` produces, and for the same reason: it is
a short, provider-truncated preview.

This means Jooble JD text is **short**. It is enough for keyword-level fit
signals and not enough for deep JD analysis; that limitation is shared with
Adzuna and is documented in the phase 2.1 design note.

---

## 6. Configuration and runtime validation

### 6.1 `.env.example`

The committed example file gained the entry below (placeholders only, as that
file's own header requires). It is deliberately verbose, because this key is
the only one in this project whose *transport* is the security problem:

```bash
# Jooble REST API — server/worker-only. Unlike every other credential above,
# the key for THIS provider travels in the request URL PATH
# (POST https://jooble.org/api/{JOOBLE_API_KEY}), not in a header, so it leaks
# through anything that records a URL: logs, error messages, APM/Sentry spans,
# n8n execution data. Never log it and never paste it into a URL you print —
# use REDACTED_JOOBLE_ENDPOINT from server/ingestion/adapters/jooble.ts.
#
# Two provider facts that make this key different from the others:
#   1. It is COUNTRY-SCOPED. Each Jooble domain issues its own key and returns
#      only that country's listings (jooble.org => US, uk.jooble.org => UK).
#      A key used against the wrong domain returns HTTP 403, not empty results.
#   2. The free plan is a LIFETIME quota of 500 requests per key (not monthly).
#      A retry or a pagination step spends it. Keep a separate key for local
#      development if the portal allows it, so testing cannot consume the
#      production allowance.
# Register at https://jooble.org/api/about (or your target country's domain).
JOOBLE_API_KEY=your_key_here
```

### 6.2 Runtime validation

Validation follows this repository's existing lazy-read convention (the same
one adzuna.ts, usajobs.ts, and openaiClient.ts use): `process.env` is read
**at call time**, never at module load, so importing the adapter never requires
the variable to exist. A credential problem therefore throws from inside
discovery, which is the behaviour `worker.ts` already expects for the
other aggregators.

`readJoobleCredentials()` behaviour:

| `JOOBLE_API_KEY` value | Result |
| --- | --- |
| unset | Throws an error naming `JOOBLE_API_KEY`, with the portal URL to register at |
| `""` or whitespace only | Same as unset |
| `your_key_here` (or another known placeholder) | Throws, saying the value is still the `.env.example` placeholder |
| real-looking value | Returns `{ apiKey: <trimmed> }` |

The thrown message **never contains the value** — and there is a test that
asserts exactly that (§8.1).

### 6.3 Target-config validation

`validateConfig()` runs **before any request is spent**. With a
500-request lifetime quota that ordering is a correctness requirement rather
than a style preference: a typo in a config row would otherwise cost a request
to discover.

| Condition | Behaviour |
| --- | --- |
| Missing/blank `keywords` | Throws naming the field (Jooble documents it as required) |
| Missing/blank `location` | Throws naming the field |
| `radius` not one of `0,4,8,16,26,40,80` | Throws, listing the allowed values |
| `country` set but blank or not a string | Throws |
| `salary`/`resultsPerPage`/`maxPages`/`searchMode` not a finite number | Throws naming the field |
| Valid | Passes; numeric fields are then clamped to safe ranges |

### 6.4 Optional: fail fast at boot

The repo has no startup config pre-check, and this adapter deliberately does
not add one for a single source — it would make the API server refuse to start
because a discovery credential is missing, which is the wrong tradeoff. If you
want an early warning anyway, the safest place is a log-only check at boot
(never a hard failure):

```ts
// server/index.ts, near startup — LOG ONLY, never throw.
import { readJoobleCredentials } from "./ingestion/adapters/jooble.js";
try {
  readJoobleCredentials();
} catch (error) {
  console.warn(
    "[boot] Jooble discovery is not configured; Jooble ingestion jobs will fail until it is.",
    error instanceof Error ? error.message : "",
  );
}
```

---

## 7. Logging rules

### 7.1 The one rule, and why it is unusual

**Never log the Jooble API key, and never log a Jooble request URL.**

Everywhere else in this codebase, the safe habit is "don't log the credential
header". Jooble has no credential header. The key is a **path segment**:

```text
POST https://jooble.org/api/your_key_here
                       ^^^^^^^^^^^^^ this is the secret
```

So a URL is a credential. Any of these leaks it, and none of them is a
"logging the API key" mistake in the obvious sense:

| Sink | How the key escapes |
| --- | --- |
| HTTP request logging (morgan, pino-http, Express middleware) | Logs the request line or the URL |
| An APM/tracing agent (Sentry, Datadog, New Relic, OpenTelemetry) | Captures the full URL and query string on every span and breadcrumb |
| A thrown error's stack or cause | A fetch/HTTP client's own message often embeds the URL |
| n8n | Execution records, node error output, and workflow JSON if the key was pasted literally |
| `curl -v` / Postman Console | Prints the resolved URL |
| CI logs | Any debug echo of the environment |
| A screenshot or a pasted error message | The same URL, now on a chat server |

### 7.2 What the code does about it

The adapter is written so that the credential cannot reach a message by
accident:

1. Every error it throws is built from `REDACTED_JOOBLE_ENDPOINT`
   (`https://jooble.org/api/{JOOBLE_API_KEY}`) — never from the real URL.
2. Transport-layer failures are **classified and discarded**, not re-thrown:
   the adapter notes "no HTTP response" and throws its own message, precisely
   because a fetch implementation's error text can embed the URL.
3. The only log line the adapter emits is the truncation warning, which
   contains counts and budgets only. A test asserts it does not contain the key.
4. `redactJoobleEndpoint()` is exported for URLs that originate
   **outside** the adapter — a fetch error, an n8n node, a Sentry breadcrumb:

```ts
import { redactJoobleEndpoint } from "./server/ingestion/adapters/jooble.js";

const safe = redactJoobleEndpoint(
  "request to https://jooble.org/api/abcd-1234 failed",
);
// "request to https://jooble.org/api/{JOOBLE_API_KEY} failed"
```

It consumes everything from the path onward, query string and fragment
included, and leaves non-Jooble URLs untouched.

### 7.3 Scrubbing the sinks you do not control

- **Express request logging** — if you add any, redact the path before it is
  written: `redactJoobleEndpoint(req.originalUrl)`.
- **Sentry** — in `Sentry.init`, add a `beforeSend` that runs
  `redactJoobleEndpoint` over `event.message`,
  `event.request?.url`, every breadcrumb's `data.url` and
  `message`, and every exception value. Also set
  `denyUrls: [/jooble\.org\/api\//]` so the request is not captured at
  all.
- **OpenTelemetry / Datadog** — use a span processor or a scrubbing rule that
  rewrites URL-ish attributes (`http.url`, `http.target`,
  `url.full`) before export. Scrubbing after export is too late.
- **n8n** — §3.3.

### 7.4 A cheap way to prove you have no leak

Run this against the repository before every commit, and against your log store
when you suspect one. It looks for the *shape* of a real key in a Jooble URL,
so it works without knowing the key:

```bash
# 1. Nothing in the working tree or history should look like a real key in a URL.
#    A match on "{JOOBLE_API_KEY}" or "your_key_here" is the redacted/example
#    form and is fine; anything else is a finding.
git grep -nE 'jooble\.org/api/[A-Za-z0-9_-]{8,}'
git log -p --all -S'jooble.org/api/' | grep -E 'jooble\.org/api/[A-Za-z0-9_-]{8,}' | head

# 2. Local log scan (adjust the path/glob to your logging setup).
grep -rEho 'jooble\.org/api/[A-Za-z0-9_-]{8,}' ./logs 2>/dev/null | sort -u
```

A pre-commit secret scanner (`gitleaks` or `trufflehog`) is worth
adding for the whole repository, not just this key — note that
`chatgpt api key.txt` already sits in the repo root and is only protected
by a `.gitignore` line, which a scanner would catch as a class of problem
rather than a one-off.

---

## 8. Acceptance tests and failure cases

### 8.1 Automated — `server/ingestion/adapters/jooble.test.ts`

42 tests, all fixtures taken from Jooble's documented example (including its
7-fractional-digit timestamp and its string-typed parameters). Run with:

```bash
npx vitest run server/ingestion/adapters/jooble.test.ts
npx vitest run server/ingestion/adapters/registry.test.ts      # registration
npx vitest run server/opportunities/jdExtraction.test.ts       # JD extractor
```

| Requirement | Test |
| --- | --- |
| Key missing/blank/placeholder rejected before spending a request | "throws naming JOOBLE_API_KEY…", "rejects the .env.example placeholder…" |
| **No error message ever contains the key** | "SECURITY: no thrown error message ever contains the API key" — runs all six failure statuses |
| Redaction helper strips path, query, and every occurrence | `redactJoobleEndpoint` suite (4 tests) |
| Documented request shape (URL, method, headers, string params) | "POSTs to the key-bearing endpoint with Jooble's documented string payload" |
| Documented response normalizes correctly | "maps the documented fixture into DiscoveredVacancy" |
| Raw payload preserved verbatim for JD extraction | "keeps the raw payload verbatim…" |
| Salary string parsing, all documented forms + refusals to guess | `parseJoobleSalary` suite (6 tests) |
| Pagination follows pages and stops at the end | "paginates until a short page…", "stops as soon as totalCount is covered" |
| Cross-page duplicate listings de-duplicated | "dedupes a job that appears on more than one page" |
| Request budget never exceeded, truncation warned about | "never exceeds maxRequestsPerRun and warns loudly…" |
| Retry on transient failure, with the extra request counted | "retries a transient 503 once, spending a second request" |
| `Retry-After` honoured | "honours Retry-After on a 429" |
| **403 not retried** | "does NOT retry a 403 — one request, then a credential-shaped error" |
| 404 and unlisted 4xx not retried | "does NOT retry a 404 or an unlisted 4xx" |
| Exhausted retry budget surfaces the final status | "surfaces an exhausted retry budget with the final status" |
| Transport failure retried | "retries a transport failure with a redacted message" |
| Non-JSON 200 and missing `jobs` array both fail without retrying | two tests |
| Empty result set is success, not an error | "accepts an empty result set as a valid, non-error outcome" |
| Pacing floor enforced | "paces sequential page requests by at least minIntervalMs" |
| Config validation, incl. rejection before any request | `joobleAdapter` suite (5 tests) |
| Registry integration | `registry.test.ts` — includes the source-count assertion updated from 4 to 5 |

### 8.2 Manual, end to end — the one test that needs a real key

The fixtures above pin *this repository's understanding* of Jooble's contract.
usajobs.ts already documents why that is not the same as the live contract. This
check closes that gap, and costs exactly one request:

```bash
npm run jooble:smoke -- --confirm-spend
```

It refuses to run without `--confirm-spend` so a stray invocation cannot
silently spend quota. It performs one request (`maxPages: 1`,
`maxRetries: 0`), never touches the database — so it works before the
migration or any target row exists — and reports:

- how many vacancies normalized, and how many carried a parseable salary;
- **a contract diff: fields Jooble's documentation lists that were absent, and
  fields present that are undocumented.** Any entry here is a finding worth
  recording in §12;
- the normalized fields of the first three vacancies, so a wrong mapping is
  visible immediately;
- a redaction self-check that proves the key is not rendered into a URL.

Override the search without editing the file:

```bash
JOOBLE_SMOKE_KEYWORDS="Data Engineer" JOOBLE_SMOKE_LOCATION="Berlin" JOOBLE_SMOKE_COUNTRY=DE \
  npm run jooble:smoke -- --confirm-spend
```

Expected output shape:

```text
[jooble-smoke] endpoint: https://jooble.org/api/{JOOBLE_API_KEY}
[jooble-smoke] search: keywords="Sales Manager" location="United States"
[jooble-smoke] budget: 1 request, 0 retries (maxPages=1, maxRetries=0)

[jooble-smoke] normalized 20 vacancies in 412ms

[jooble-smoke] contract check against the documented job fields:
[jooble-smoke]   fields present: 10
[jooble-smoke]   documented but absent: (none)
[jooble-smoke]   present but undocumented: (none)

[jooble-smoke] normalized output (first 3):
  - id=1234567890 title="Sales Manager" company="ABC Corp" country=US
    salary=17600-17600 UAH interval=null publishedAt=2023-09-15T12:55:35.3870000
    linkHost=ua.jooble.org

[jooble-smoke] redaction self-check: PASS
[jooble-smoke]   a credential-bearing URL renders as: https://jooble.org/api/{JOOBLE_API_KEY}

[jooble-smoke] done. Remember to top up your mental counter: 1 request spent.
```

### 8.3 Failure cases and what each one means

| Symptom | Cause | Action |
| --- | --- | --- |
| `HTTP 403` on every request | Key issued for a different country domain than the one queried — the most common cause. Or the key was revoked | Re-check §1.1. Confirm the domain the key came from before rotating |
| `HTTP 403` after working previously | Key rotated or revoked upstream | Rotate per §9.1 |
| `HTTP 404` | Key truncated/malformed in transit (a copy-paste that dropped characters, or a value with stray whitespace) | Re-copy from the portal. The adapter trims whitespace on read, but cannot repair a truncated key |
| `JOOBLE_API_KEY…unset or blank` | Variable not injected into the worker's environment | Check the process env, not just your shell — a worker started before the variable was set will not see it |
| `…still the .env.example placeholder` | `.env` was copied from `.env.example` and not filled in | Expected on a fresh clone; fill it in |
| `requires a non-empty "keywords"` / `"location"` | Bad `vacancy_sources.config` row | Fix the row. No request was spent |
| `"radius" must be one of…` | `radius` not in Jooble's allowed set | Fix the row. No request was spent |
| `request budget exhausted` | `maxRequestsPerRun` reached before the search completed | Deliberately conservative. Raise it knowingly — each request is permanent |
| `[jooble] partial discovery: returned X of Y` | The run could not cover the whole result set | **Not noise.** See §4.4 — unfetched vacancies may be expired by the freshness sweep |
| `no 'jobs' array` | Response shape did not match the documented contract | Do not retry blindly; re-run the smoke check and record the actual shape in §12 |
| `not valid JSON` | An HTML error page or an interstitial was returned with 200 | Usually a WAF/proxy in front of the request |
| Transport failure, repeated | DNS, egress firewall, or proxy blocking `jooble.org` | Check worker egress. Retries are exhausted after `maxRetries`; the worker then applies its own backoff and dead-letter |
| Zero jobs for a broad search | Key is valid but the market/keywords pair is empty | Broaden the search; do **not** rotate the key |
| `source_policies row for "jooble" not found` | Migration not applied | Apply `20260902000000_jooble_source_policy.sql` |

### 8.4 Verifying the write path once the key is live

```sql
-- The job should have completed, with a health event recorded either way.
select status, attempts, last_error, updated_at
from ingestion_jobs
order by updated_at desc
limit 5;

select source_code, status, vacancies_fetched, error_message, created_at
from source_health_events
where source_code = 'jooble'
order by created_at desc
limit 5;

-- And the vacancies themselves, with the fields that normalization decides.
select source_vacancy_id, raw_title, country, salary_min, salary_max,
       currency, salary_interval, salary_source, published_at, status
from vacancies
where source_code = 'jooble'
order by created_at desc
limit 20;
```

Check specifically that `country` is populated (it comes only from target
config), that `salary_interval` is null (never guessed), and that
`salary_source` is `estimated`.

---

## 9. Security

### 9.1 Rotation runbook

Rotate when: the key is suspected leaked, a person with access leaves, the
environment is rebuilt, or on a scheduled interval (Jooble documents no expiry,
so interval rotation is a policy choice — quarterly is reasonable).

1. **Register a new key** on the same country domain (`§1.1`). Jooble
   documents no rotation UI, so treat "register again" as the process —
   confirm whether the portal can issue an additional key for the same account
   (§1.4).
2. **Update every environment**: production secrets manager, the worker host's
   environment, n8n's environment if it holds a copy, and local `.env`
   for developers. Use a single change window; the old key stays valid until
   Jooble revokes it, so both work briefly.
3. **Restart / redeploy** so the new value is actually loaded. Because
   `readJoobleCredentials()` reads `process.env` at call time, a
   long-lived worker process will pick up a new value on its next discovery run
   only if its environment was updated — a process started before the change
   keeps the old value in memory until restarted.
4. **Verify** with `npm run jooble:smoke -- --confirm-spend` (one
   request) or by queueing a single ingestion job and checking
   `source_health_events`.
5. **Revoke the old key** with Jooble support if the portal does not expose
   revocation. Until it is revoked, a leaked key remains usable — and every
   request an attacker makes comes out of the same 500-request lifetime
   allowance as yours.
6. **Record the rotation**: date, who, why, which environments were updated.

### 9.2 If the key leaks

Treat every leak as a compromise; there is no "it was only a private log".

1. **Rotate first, investigate second** (§9.1). The key has no scopes and no
   rate limit that would blunt abuse — its whole value is the allowance.
2. **Find the sink**: check the log store, the APM, n8n execution records, CI
   logs, and git history. §7.4 gives the scan.
3. **If it was committed to git**, deleting the file is not enough — the blob
   stays in history:
   ```bash
   git log --all -p -S'JOOBLE_API_KEY=' -- . | head      # find the commit
   # Then rewrite history (git filter-repo / BFG), force-push, and have every
   # clone re-fetch. Coordinate: a rewrite is disruptive and does not un-share
   # anything already pushed.
   ```
   Because the key was already pushed, rotation is mandatory regardless of the
   rewrite.
4. **Check for abuse**: Jooble exposes no usage dashboard this repo relies on,
   so the practical signal is a sudden 403 (quota exhausted) or unexplained
   empty results. Keep a rough count of your own request spend so a surprise
   is noticeable.

### 9.3 `.gitignore` — verified, not assumed

```bash
$ cat .gitignore
node_modules/
dist/
.env
.env.*
!.env.example
*.log
.DS_Store
Thumbs.db

/docs/JobBeacon End-to-End Documentation.pdf
chatgpt api key.txt

$ git check-ignore -v .env
.gitignore:3:.env        .env
```

`.env` and every `.env.*` variant are ignored, with an explicit
un-ignore for `.env.example` only. No change was needed. Keep it that way:
**never** add a `!.env` negation to make a specific file trackable, and
never move a real value into a tracked file "just for one deploy".

### 9.4 Secrets manager, concretely

- **One credential, one place.** The preferred n8n arrangement (§3.3) keeps the
  key only in the server's environment. Every extra copy is another rotation
  step you can forget.
- **Environment injection, never build-time baking.** If the value is present
  when the image is built, it is in a layer, and layers are readable by anyone
  who can pull the image.
- **Least access.** Scope the secret to the ingestion worker; do not make it
  readable by the API server process if that process never discovers.
- **No client exposure, ever.** `VITE_*` would publish it (§3.4).
- **Table storage is not secret storage.** Do not put it in a Supabase table —
  anything with a service-role key can read it, and it would appear in backups
  and query logs.
- **Log the key's fingerprint, never the key.** If you need to prove which key
  is live, log a truncated SHA-256 of it:
  ```ts
  import { createHash } from "node:crypto";
  const fingerprint = createHash("sha256").update(apiKey).digest("hex").slice(0, 8);
  // safe to log: correlates a deployment with a key without revealing it
  ```

---

## 10. Implementation plan

### Phase A — code (done in this repository)

| # | Artifact | State |
| --- | --- | --- |
| A1 | `server/ingestion/adapters/jooble.ts` — adapter | Done |
| A2 | `server/ingestion/adapters/jooble.test.ts` — 42 tests | Done, passing |
| A3 | `server/ingestion/adapters/registry.ts` — registered as `jooble` | Done |
| A4 | `server/ingestion/adapters/registry.test.ts` — count 4 → 5 | Done |
| A5 | `server/opportunities/jdExtraction.ts` + test — `jooble` extractor | Done |
| A6 | `.env.example` — `JOOBLE_API_KEY` entry with warnings | Done |
| A7 | `supabase/migrations/20260902000000_jooble_source_policy.sql` | Done |
| A8 | `server/ingestion/joobleSmoke.ts` + `npm run jooble:smoke` | Done |

A5 is the one that is easy to miss: without it, every Jooble vacancy throws
`UnknownJdSourceError` in the fit pipeline.

### Phase B — operator steps (needs a human and a real key)

1. **Choose the country domain** and register (§1.1–1.2). Record which domain.
2. **Store the key**: password manager + the environment(s) it belongs in (§3).
3. **Verify by hand** with one `curl` call (§2). Expect 200 with
   `jobs`. A 403 here means the domain is wrong — fix it before
   continuing.
4. **Run the live smoke check**: `npm run jooble:smoke -- --confirm-spend`
   (§8.2). Record the contract diff and the `totalCount` it reports.
   **`totalCount` is what you size the target against — do this before
   step 6.**
5. **Apply the migration**: `supabase migration up` (or your usual
   pipeline). This creates the `source_policies` row for `jooble`
   that `worker.ts` requires.
6. **Seed one target row** in `vacancy_sources`, using the commented
   template at the bottom of the migration. Set `maxPages * resultsPerPage`
   above the `totalCount` from step 4 and set `country` to the
   domain's country. **Leave `enabled = false`** until step 8.
7. **Queue one job** by hand and watch it drain:
   ```sql
   insert into ingestion_jobs (source_code, vacancy_source_id, status)
   select 'jooble', id, 'pending' from vacancy_sources
   where source_code = 'jooble' and target_key = 'your-target-key';
   ```
   Then run the worker (`POST /api/worker/run`, or the CLI) and check
   §8.4's queries.
8. **Confirm the freshness interaction** (§4.4): no `partial discovery`
   warning in the log, and the vacancy count stable across two consecutive runs
   (no flapping between active and expired).
9. **Enable the target** (`enabled = true`) and let n8n/cron drive it.

### Phase C — rollout discipline

- Ramp the schedule slowly. Every run costs at least one request, so a
  once-every-15-minutes schedule would exhaust 500 requests in about five days
  and then fail forever. **At 500 lifetime requests, a sane interval is measured
  in days, not minutes** — e.g. daily is ~2 years of budget; hourly is ~3 weeks.
- Add the request spend to your monitoring alongside
  `source_health_events` (see §11, item 2).
- Watch for the truncation warning before it becomes an expiry-churn incident.

---

## 11. Known risks and follow-ups

Ordered by how much they matter.

1. **Freshness/expiry churn on truncated runs (highest).** Described in §4.4.
   With a paginated source on a lifetime quota, a run that covers only part of
   the result set causes `markUnseenVacanciesExpired()` to expire
   vacancies it merely did not fetch. Mitigations are config-level today
   (§4.4 items 1–2); the real fix is a "discovery was complete" signal from the
   adapter into `worker.ts` so the sweep is skipped on a partial run.
   **Not implemented here because it changes shared pipeline behaviour for all
   five sources and deserves its own reviewed change.**
2. **No durable quota accounting.** The adapter caps requests per run, but
   nothing counts lifetime spend, so the 500-request allowance can only be
   tracked by hand. Follow-up: add a `requests_made` column to
   `source_health_events` and have the adapter report its request count
   (the worker already writes `vacancies_fetched` and `duration_ms`,
   so this is a small extension), then alert on cumulative spend.
3. **Short JD text.** Only `snippet` is available, so fit analysis has
   limited signal — the same limitation Adzuna has.
4. **No country field in the payload.** `vacancies.country` depends
   entirely on operator-supplied config; a wrong `country` is silently
   wrong data rather than an error.
5. **Compliance review pending.** The `source_policies` row ships as
   `policy_version = 'jooble-tou-review-pending'` with
   `last_legal_review_at` null, deliberately, so the outstanding review
   is visible in the data. Jooble's terms govern storage and display; confirm
   them before this source is displayed to candidates, then update the row.
6. **No `type`/`snippet` columns.** Employment type and snippet
   live only in `raw`. Adding columns is a schema change with migration
   and display implications, so it was not done here.
7. **`client/src/pages/admin/SourcesSection.tsx`** may need a Jooble
   label/entry if the admin surface enumerates sources explicitly; not changed
   here because it was not needed for ingestion and touches UI.

## 12. Assumptions not yet verified against the live API

Each of these is a place where this adapter encodes a judgement that a real
response could contradict. The smoke check (§8.2) is designed to surface them —
record what it reports here.

| # | Assumption | Where it is encoded | Confidence |
| --- | --- | --- | --- |
| 1 | Request params are sent as JSON **strings**, matching Jooble's worked example, despite its parameter table typing them as integer/boolean | `buildRequestBody()` | Medium — the example is the only concrete wire evidence |
| 2 | `ResultOnPage` has no documented maximum; 100 is a self-imposed cap | `DEFAULT_RESULTS_PER_PAGE` | Medium — Jooble documents the parameter, not its ceiling |
| 3 | Jooble publishes no numeric rate limit; 1.1 s pacing is a self-imposed floor | `DEFAULT_MIN_INTERVAL_MS` | High that no limit is published; the value itself is a choice |
| 4 | A single `salary` figure means both bounds rather than an unstated ceiling | `parseJoobleSalary()` | Medium — a judgement call, documented at the call site |
| 5 | `salary` is recorded as `estimated` rather than `employer_disclosed` | `normalizeJoobleJob()` | Medium — deliberately conservative, matching adzuna.ts |
| 6 | The 7-digit fractional timestamp is accepted by Postgres as-is | `publishedAt` pass-through | High — Postgres rounds extra fractional digits |
| 7 | `403` means a credential/domain problem and is never retried | retry classification | High — Jooble documents 403 as "invalid or missing API key", plus the documented regional restriction |
| 8 | One account can hold only one key per domain (affects dev/prod separation) | §1.4, §3.2 | **Unknown** — ask Jooble support |
| 9 | Only `200/403/404` occur; other statuses are handled generically | error taxonomy | Medium — Jooble documents three codes; the adapter degrades safely on anything else |

---

## Appendix — file reference

| File | Role |
| --- | --- |
| `server/ingestion/adapters/jooble.ts` | The adapter: env validation, request building, pagination, pacing, retries, quota guard, normalization, redaction |
| `server/ingestion/adapters/jooble.test.ts` | 42 unit/acceptance tests, including the no-key-in-errors assertion |
| `server/ingestion/joobleSmoke.ts` | One-request live acceptance check with a contract diff |
| `server/ingestion/adapters/registry.ts` | Registers the adapter under source code `jooble` |
| `server/ingestion/worker.ts` | Unchanged; resolves `jooble` through the registry and owns job-level retry/dead-letter |
| `server/opportunities/jdExtraction.ts` | `jooble` JD extractor (required — unknown sources throw) |
| `supabase/migrations/20260902000000_jooble_source_policy.sql` | `source_policies` row + a commented target template |
| `.env.example` | `JOOBLE_API_KEY` placeholder and its warnings |
| `package.json` | `npm run jooble:smoke` |

### Sources

- Jooble REST API documentation —
  https://help.jooble.org/en/support/solutions/articles/60001448238-rest-api-documentation
  (request parameters, response fields, 200/403/404, regional domain
  restriction, 500-request lifetime quota)
- How to connect to the Jooble REST API —
  https://help.jooble.org/en/support/solutions/articles/60000922689-how-to-connect-to-the-jooble-rest-api
  (registration flow, key placement in the URL path, terms of use)

