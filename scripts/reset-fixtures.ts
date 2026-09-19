import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient } from "../server/supabaseServiceRole.js";

/**
 * scripts/reset-fixtures.ts — remove the local fixture postings and everything
 * derived from them.
 *
 * WHY THIS EXISTS. Every end-to-end demonstration of the application pipeline
 * consumes a local_fixture posting: createAttemptIfNoneActive refuses a second
 * application against a posting that already has an active attempt, and
 * 'succeeded' counts as active. Two tasks in a row were unblocked by adding one
 * more seeded posting in a migration, which is a treadmill with a schema
 * history attached — the fixtures accumulate forever and the migrations stop
 * describing the schema and start describing a debug session.
 *
 * WHAT IT DELETES, in dependency order, all scoped to local_fixture:
 *   1. application_evidence      (via the attempt ids)
 *   2. application_attempts      (via the plan ids)
 *   3. action_required_events    (via the attempt ids)
 *   4. messages                  (application_attempt_id -> null, not deleted:
 *                                 see below)
 *   5. application_plans
 *   6. vacancies
 *   7. companies                 — ONLY those left with no vacancies
 *   8. vacancy_source_records / vacancy_versions / vacancy_fingerprints for
 *      the deleted vacancies, if the FK is not already cascading.
 *
 * WHAT IT DELIBERATELY KEEPS:
 *   * The source_policies and vacancy_sources rows. They are configuration, not
 *     fixtures — re-adding them would be another migration, and the whole point
 *     is to stop writing those.
 *   * resume_documents. A tailored resume generated for a fixture application
 *     is a real artifact with a real Storage object; deleting the row would
 *     orphan the file. Reported as a count so it can be cleaned deliberately.
 *   * messages. A mailbox message that matched a fixture attempt is real
 *     received mail. It is unlinked (application_attempt_id -> null), never
 *     deleted: import must not destroy the candidate's correspondence.
 *
 * SAFETY. Refuses to run when NODE_ENV=production. Prints exactly what it will
 * delete and requires --yes to proceed; --dry-run reports without deleting.
 * Every delete is scoped by source_code = 'local_fixture' or by an id collected
 * from that scope, so it cannot reach a real posting.
 */

export const FIXTURE_SOURCE_CODE = "local_fixture";

/**
 * The canonical fixture postings, restored after every reset.
 *
 * WHY THIS SCRIPT RESTORES RATHER THAN ONLY DELETES. A pure delete would make
 * the database permanently disagree with its own migrations: 20260917170000
 * seeds these postings, and once deleted that migration never re-runs, so a
 * "reset" would quietly leave the fixture source with nothing in it and no way
 * back except `supabase db reset` — which destroys everything else too.
 *
 * Restoring makes this genuinely repeatable: reset, run a demonstration, reset
 * again. That is what actually ends the treadmill, because the alternative
 * (a new one-row migration per demonstration) was only ever needed to get the
 * postings BACK.
 *
 * These three mirror 20260917170000_local_fixture_source.sql exactly. The
 * postings later migrations added for individual tasks (local-fixture-4
 * through -7) are deliberately NOT restored: they were the treadmill, and the
 * point of this script is that they are no longer the mechanism.
 */
export const FIXTURE_POSTINGS = [
  { sourceVacancyId: "local-fixture-1", posting: 1, title: "[MOCK] Data Engineer — Local Fixture" },
  { sourceVacancyId: "local-fixture-2", posting: 2, title: "[MOCK] Data Analyst — Local Fixture" },
  { sourceVacancyId: "local-fixture-3", posting: 3, title: "[MOCK] Software Engineer — Local Fixture" },
] as const;

export const FIXTURE_BASE_URL = "http://127.0.0.1:5000/mock-employer/apply";

/**
 * The fixture employer, given an identity so the response loop can be
 * demonstrated against it.
 *
 * Without a companies row these postings have company_id NULL, and the
 * application matcher has nothing to match an employer email against — a reply
 * from "the mock employer" could never be tied to the application it answers.
 * The domain is deliberately under .test (RFC 2606 reserves it, so it can never
 * resolve to a real host) and is used as the sender domain in the sample
 * payloads under docs/, which is what makes sender_domain_match fire.
 */
export const FIXTURE_COMPANY = {
  displayedName: "Local Fixture Employer",
  domain: "mock-employer.test",
} as const;

export interface FixtureInventory {
  vacancyIds: string[];
  planIds: string[];
  attemptIds: string[];
  evidenceCount: number;
  actionRequiredCount: number;
  linkedMessageCount: number;
  tailoredResumeCount: number;
  companyIds: string[];
}

/** Everything about to be removed, counted before anything is removed. */
export async function inspectFixtures(client: SupabaseClient): Promise<FixtureInventory> {
  const { data: vacancies, error: vacancyError } = await client
    .from("vacancies")
    .select("id, company_id")
    .eq("source_code", FIXTURE_SOURCE_CODE);

  if (vacancyError) throw vacancyError;

  const rows = (vacancies ?? []) as Array<{ id: string; company_id: string | null }>;
  const vacancyIds = rows.map((row) => row.id);

  if (vacancyIds.length === 0) {
    return {
      vacancyIds: [], planIds: [], attemptIds: [],
      evidenceCount: 0, actionRequiredCount: 0, linkedMessageCount: 0, tailoredResumeCount: 0, companyIds: [],
    };
  }

  const { data: plans, error: planError } = await client
    .from("application_plans")
    .select("id")
    .in("vacancy_id", vacancyIds);

  if (planError) throw planError;

  const planIds = ((plans ?? []) as Array<{ id: string }>).map((row) => row.id);

  const { data: attempts, error: attemptError } = planIds.length
    ? await client.from("application_attempts").select("id").in("application_plan_id", planIds)
    : { data: [], error: null };

  if (attemptError) throw attemptError;

  const attemptIds = ((attempts ?? []) as Array<{ id: string }>).map((row) => row.id);

  const countIn = async (table: string, column: string, values: string[]): Promise<number> => {
    if (values.length === 0) return 0;
    const { count, error } = await client.from(table).select("id", { count: "exact", head: true }).in(column, values);
    if (error) throw error;
    return count ?? 0;
  };

  const { count: tailoredResumeCount } = await client
    .from("resume_documents")
    .select("id", { count: "exact", head: true })
    .eq("kind", "tailored")
    // Scoped to tailored documents this fixture run produced by matching the
    // fixture filename convention, not every tailored resume in the database:
    // a candidate's real applications must not be collateral.
    .like("original_filename", "%local-fixture%");

  return {
    vacancyIds,
    planIds,
    attemptIds,
    evidenceCount: await countIn("application_evidence", "application_attempt_id", attemptIds),
    actionRequiredCount: await countIn("action_required_events", "application_attempt_id", attemptIds),
    linkedMessageCount: await countIn("messages", "application_attempt_id", attemptIds),
    tailoredResumeCount: tailoredResumeCount ?? 0,
    companyIds: [...new Set(rows.map((row) => row.company_id).filter((id): id is string => id !== null))],
  };
}

export interface ResetReport {
  deleted: Record<string, number>;
  retained: Record<string, string | number>;
  restored: number;
  remainingFixtureVacancies: number;
}

/**
 * Re-inserts the canonical postings. Idempotent via the same unique key the
 * seeding migration relies on, so a reset over a partially-reset database
 * converges rather than erroring.
 */
export async function restoreFixturePostings(client: SupabaseClient): Promise<number> {
  const { data: source, error: sourceError } = await client
    .from("vacancy_sources")
    .select("id")
    .eq("source_code", FIXTURE_SOURCE_CODE)
    .limit(1)
    .maybeSingle();

  if (sourceError) throw sourceError;

  if (!source) {
    throw new Error(
      `No vacancy_sources row exists for "${FIXTURE_SOURCE_CODE}", so the fixture postings cannot be restored. Run the migrations first.`,
    );
  }

  const vacancySourceId = (source as { id: string }).id;

  // Upsert the company first, so the postings can reference it. companies
  // .displayed_name is unique, which is what makes this idempotent across
  // repeated resets.
  const { data: company, error: companyError } = await client
    .from("companies")
    .upsert(
      { displayed_name: FIXTURE_COMPANY.displayedName, domain: FIXTURE_COMPANY.domain },
      { onConflict: "displayed_name", ignoreDuplicates: true },
    )
    .select("id")
    .maybeSingle();

  if (companyError) throw companyError;

  // ignoreDuplicates can return no row when the company already existed;
  // re-read it rather than assuming.
  let companyId = (company as { id: string } | null)?.id ?? null;

  if (!companyId) {
    const { data: existing, error: existingError } = await client
      .from("companies")
      .select("id")
      .eq("displayed_name", FIXTURE_COMPANY.displayedName)
      .maybeSingle();

    if (existingError) throw existingError;
    companyId = (existing as { id: string } | null)?.id ?? null;
  }

  if (!companyId) {
    throw new Error(`Could not resolve the fixture company "${FIXTURE_COMPANY.displayedName}".`);
  }

  const { error } = await client.from("vacancies").upsert(
    FIXTURE_POSTINGS.map((posting) => ({
      source_code: FIXTURE_SOURCE_CODE,
      vacancy_source_id: vacancySourceId,
      source_vacancy_id: posting.sourceVacancyId,
      authoritative_url: `${FIXTURE_BASE_URL}?posting=${posting.posting}`,
      raw_title: posting.title,
      company_id: companyId,
      country: "XX",
      status: "active",
      trust_status: "VERIFIED",
    })),
    { onConflict: "source_code,source_vacancy_id", ignoreDuplicates: true },
  );

  if (error) throw error;

  return FIXTURE_POSTINGS.length;
}

/**
 * Deletes the fixture scope. Order is dependency-first because there is no
 * ON DELETE CASCADE from application_plans to vacancies to lean on: deleting
 * the vacancy first would fail on the plan's foreign key.
 */
export async function resetFixtures(client: SupabaseClient): Promise<ResetReport> {
  const inventory = await inspectFixtures(client);
  const deleted: Record<string, number> = {
    application_evidence: 0,
    action_required_events: 0,
    application_attempts: 0,
    application_plans: 0,
    vacancies: 0,
    companies: 0,
  };

  /**
   * Deletes and counts what was ACTUALLY removed, by asking for the deleted
   * rows back.
   *
   * The first version of this counted the ids it passed in, which reported
   * "action_required_events: 7" for a table holding none of them — a number
   * that looked like a successful deletion and described nothing. A report of
   * what a destructive script did is only useful if it is the truth about what
   * happened.
   */
  const deleteIn = async (table: string, column: string, values: string[]): Promise<void> => {
    if (values.length === 0) return;
    const { data, error } = await client.from(table).delete().in(column, values).select("id");
    if (error) throw error;
    deleted[table] = (deleted[table] ?? 0) + ((data ?? []) as unknown[]).length;
  };

  await deleteIn("application_evidence", "application_attempt_id", inventory.attemptIds);
  await deleteIn("action_required_events", "application_attempt_id", inventory.attemptIds);

  // Unlink, never delete: these are real received emails.
  if (inventory.attemptIds.length > 0) {
    const { error } = await client
      .from("messages")
      .update({ application_attempt_id: null })
      .in("application_attempt_id", inventory.attemptIds);
    if (error) throw error;
  }

  await deleteIn("application_attempts", "id", inventory.attemptIds);
  await deleteIn("application_plans", "id", inventory.planIds);
  await deleteIn("vacancies", "id", inventory.vacancyIds);

  // Companies are only removed once nothing references them — a fixture
  // company shared with a real posting must survive.
  let companiesDeleted = 0;
  for (const companyId of inventory.companyIds) {
    const { count, error } = await client
      .from("vacancies")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId);

    if (error) throw error;
    if ((count ?? 0) > 0) continue;

    const { error: deleteError } = await client.from("companies").delete().eq("id", companyId);
    if (deleteError) throw deleteError;
    companiesDeleted += 1;
  }
  deleted.companies = companiesDeleted;

  const { count: remainingFixtureVacancies } = await client
    .from("vacancies")
    .select("id", { count: "exact", head: true })
    .eq("source_code", FIXTURE_SOURCE_CODE);

  const restored = await restoreFixturePostings(client);

  const { count: afterRestore } = await client
    .from("vacancies")
    .select("id", { count: "exact", head: true })
    .eq("source_code", FIXTURE_SOURCE_CODE);

  return {
    deleted,
    retained: {
      "source_policies/vacancy_sources": "kept — configuration, not fixtures",
      messages: `${inventory.linkedMessageCount} unlinked, none deleted`,
      "resume_documents (tailored)": `${inventory.tailoredResumeCount} kept — real Storage objects; remove deliberately if you want them gone`,
    },
    restored,
    remainingFixtureVacancies: afterRestore ?? remainingFixtureVacancies ?? 0,
  };
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const assumeYes = args.includes("--yes");

  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run against NODE_ENV=production. This deletes data.");
    process.exitCode = 1;
    return;
  }

  const client = createSupabaseServiceRoleClient();
  const inventory = await inspectFixtures(client);

  console.log("local_fixture scope:");
  console.log(`  vacancies:            ${inventory.vacancyIds.length}`);
  console.log(`  application_plans:    ${inventory.planIds.length}`);
  console.log(`  application_attempts: ${inventory.attemptIds.length}`);
  console.log(`  application_evidence: ${inventory.evidenceCount}`);
  console.log(`  action_required:      ${inventory.actionRequiredCount}`);
  console.log(`  messages to unlink:   ${inventory.linkedMessageCount}`);
  console.log(`  companies (candidates for removal): ${inventory.companyIds.length}`);
  console.log(`  tailored resumes kept: ${inventory.tailoredResumeCount}`);

  if (inventory.vacancyIds.length === 0) {
    console.log("\nNothing to do — no local_fixture vacancies exist.");
    return;
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing was deleted.");
    return;
  }

  // Non-interactive shells (CI, an agent's terminal) have no TTY, so a prompt
  // would hang forever. --yes is the explicit consent in that case; without it
  // the script stops rather than waiting on input that will never come.
  const interactive = process.stdin.isTTY === true;

  if (!assumeYes) {
    if (!interactive) {
      console.error("\nRefusing to delete without confirmation: stdin is not a terminal, so pass --yes.");
      process.exitCode = 1;
      return;
    }

    if (!(await confirm("\nDelete the above?"))) {
      console.log("Aborted. Nothing was deleted.");
      return;
    }
  }

  const report = await resetFixtures(client);

  console.log("\nDeleted:");
  for (const [table, count] of Object.entries(report.deleted)) {
    console.log(`  ${table}: ${count}`);
  }
  console.log("Retained:");
  for (const [what, why] of Object.entries(report.retained)) {
    console.log(`  ${what}: ${why}`);
  }
  console.log(`\nlocal_fixture vacancies remaining: ${report.remainingFixtureVacancies}`);
}

// Only when executed directly, so the functions above stay importable by tests
// without the module running a destructive command on import.
//
// pathToFileURL, not a hand-built "file://" + path: on Windows the hand-built
// form produces file://D:/... while import.meta.url is file:///D:/..., so the
// comparison silently failed and the script exited 0 having done nothing at
// all. A utility that quietly no-ops is worse than one that crashes.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
