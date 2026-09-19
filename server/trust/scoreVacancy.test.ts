import { describe, expect, it, vi } from "vitest";
import { resolveStatus, scoreVacancy } from "./scoreVacancy.js";

/**
 * Mirrors the chainable query-builder double already used in
 * ingest.test.ts / applyHardBlocks.test.ts.
 */
function makeBuilder(terminalResult: { data: unknown; error: unknown } = { data: null, error: null }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chain = (method: string) => (...args: unknown[]) => (calls.push({ method, args }), builder);
  const terminal = (method: string) => (...args: unknown[]) => (calls.push({ method, args }), terminalResult);

  const builder = {
    calls,
    select: chain("select"),
    insert: chain("insert"),
    update: chain("update"),
    eq: chain("eq"),
    single: terminal("single"),
    then: (resolve: (v: unknown) => void) => resolve(terminalResult),
  };

  return builder;
}

// Computed at run time (not a hardcoded past date) so freshness/recency
// scoring is deterministic regardless of when the suite actually runs.
const RECENT_TIMESTAMP = new Date().toISOString();

const defaultVacancyRow = {
  id: "vacancy-1",
  authoritative_url: "https://careers.acme.com/jobs/1",
  status: "active",
  last_seen_at: RECENT_TIMESTAMP,
  salary_min: 100000,
  salary_max: 130000,
  salary_source: "employer_disclosed",
  source_code: "greenhouse",
  company_id: "company-1",
  trust_status: null,
};

const defaultCompany = { domain: "acme.com", career_domain: "careers.acme.com" };
const defaultPolicy = { discovery_allowed: true, kill_switch: false };

function makeClient(overrides: {
  vacancy?: { data: unknown; error: unknown };
  company?: { data: unknown; error: unknown };
  policy?: { data: unknown; error: unknown };
  trustScoreInsert?: { data: unknown; error: unknown };
  flagsInsert?: { data: unknown; error: unknown };
  vacancyUpdate?: { data: unknown; error: unknown };
} = {}) {
  const vacancySelectBuilder = makeBuilder(overrides.vacancy ?? { data: defaultVacancyRow, error: null });
  const companyBuilder = makeBuilder(overrides.company ?? { data: defaultCompany, error: null });
  const policyBuilder = makeBuilder(overrides.policy ?? { data: defaultPolicy, error: null });
  const trustScoreBuilder = makeBuilder(overrides.trustScoreInsert ?? { data: { id: "score-1" }, error: null });
  const flagsBuilder = makeBuilder(overrides.flagsInsert ?? { data: null, error: null });
  const vacancyUpdateBuilder = makeBuilder(overrides.vacancyUpdate ?? { data: null, error: null });

  let vacancyFromCallCount = 0;

  const from = vi.fn((table: string) => {
    if (table === "vacancies") {
      vacancyFromCallCount += 1;
      return vacancyFromCallCount === 1 ? vacancySelectBuilder : vacancyUpdateBuilder;
    }
    if (table === "companies") return companyBuilder;
    if (table === "source_policies") return policyBuilder;
    if (table === "vacancy_trust_scores") return trustScoreBuilder;
    if (table === "vacancy_flags") return flagsBuilder;
    throw new Error(`Unexpected table: ${table}`);
  });

  const enqueueFitJobs = vi.fn().mockResolvedValue(undefined);

  return {
    client: { from } as unknown as Parameters<typeof scoreVacancy>[0],
    from,
    enqueueFitJobs,
    deps: { enqueueFitJobs },
    vacancySelectBuilder,
    companyBuilder,
    policyBuilder,
    trustScoreBuilder,
    flagsBuilder,
    vacancyUpdateBuilder,
  };
}

describe("scoreVacancy", () => {
  it("scores a fully favorable vacancy as VERIFIED with every confirmable positive code", async () => {
    const { client, deps, trustScoreBuilder, flagsBuilder, vacancyUpdateBuilder } = makeClient();

    const result = await scoreVacancy(client, "vacancy-1", deps);

    expect(result.status).toBe("VERIFIED");
    if (result.status !== "BLOCKED") {
      expect(result.score).toBe(85);
      expect(result.reasonCodes).toEqual(
        expect.arrayContaining([
          "OFFICIAL_CAREER_PAGE_CONFIRMED",
          "CORPORATE_DOMAIN_CONFIRMED",
          "ATS_POSTING_CONFIRMED",
          "RECENT_SOURCE_RECHECK_PASSED",
          "SALARY_EMPLOYER_DISCLOSED",
        ]),
      );
      expect(result.reasonCodes).toHaveLength(5);
    }

    expect(trustScoreBuilder.calls[0]).toEqual({
      method: "insert",
      // v2 (Task Y): a source can now declare partial verification, which
      // relabels an UNDER_REVIEW score as VERIFIED_INCOMPLETE. Scores produced
      // under v1 are not comparable, which is what this tag is for.
      args: [{ vacancy_id: "vacancy-1", status: "VERIFIED", score: 85, policy_version: "r3-trust-score-v2" }],
    });

    const insertedFlags = flagsBuilder.calls[0].args[0] as Array<{ vacancy_trust_score_id: string; reason_code: string }>;
    expect(insertedFlags).toHaveLength(5);
    expect(insertedFlags.every((flag) => flag.vacancy_trust_score_id === "score-1")).toBe(true);

    expect(vacancyUpdateBuilder.calls[0]).toEqual({ method: "update", args: [{ trust_status: "VERIFIED" }] });
    expect(vacancyUpdateBuilder.calls[1]).toEqual({ method: "eq", args: ["id", "vacancy-1"] });

    // Phase 2.1: entering VERIFIED enqueues fit analysis.
    expect(deps.enqueueFitJobs).toHaveBeenCalledWith(client, "vacancy-1");
  });

  // 20260917120000: an aggregator-shaped vacancy (aggregator-owned URL, no
  // company domain) could never clear the 80-point VERIFIED threshold — its
  // real measured ceiling was 65 — so every Jooble/USAJOBS result stayed
  // invisible to candidates no matter how many times it was re-scored.
  // source_policies.employer_identity_authoritative is what makes that
  // ceiling reachable, and deliberately only for a source that is itself the
  // employer's system of record.
  it("scores an aggregator-shaped vacancy VERIFIED only when the source is authoritative for employer identity", async () => {
    const aggregatorVacancy = {
      ...defaultVacancyRow,
      authoritative_url: "https://www.usajobs.gov:443/job/759326100",
      company_id: null,
      source_code: "usajobs",
    };

    const withoutFlag = makeClient({ vacancy: { data: aggregatorVacancy, error: null } });
    const resultWithout = await scoreVacancy(withoutFlag.client, "vacancy-1", withoutFlag.deps);
    expect(resultWithout.status).toBe("UNDER_REVIEW");
    if (resultWithout.status !== "BLOCKED") {
      expect(resultWithout.score).toBe(65);
    }

    const withFlag = makeClient({
      vacancy: { data: aggregatorVacancy, error: null },
      policy: { data: { ...defaultPolicy, employer_identity_authoritative: true }, error: null },
    });
    const resultWith = await scoreVacancy(withFlag.client, "vacancy-1", withFlag.deps);
    expect(resultWith.status).toBe("VERIFIED");
    if (resultWith.status !== "BLOCKED") {
      expect(resultWith.score).toBe(85);
    }
  });

  it("does NOT re-enqueue fit analysis when the vacancy is already VERIFIED", async () => {
    const { client, deps } = makeClient({
      vacancy: { data: { ...defaultVacancyRow, trust_status: "VERIFIED" }, error: null },
    });

    const result = await scoreVacancy(client, "vacancy-1", deps);

    expect(result.status).toBe("VERIFIED");
    expect(deps.enqueueFitJobs).not.toHaveBeenCalled();
  });

  // Phase 2.3b: the stored priority score's company_credibility factor reads
  // vacancy_trust_scores.score, so ANY bucket transition must re-enqueue —
  // not just the transition into VERIFIED.
  it("enqueues fit analysis on a non-VERIFIED bucket transition", async () => {
    const { client, deps } = makeClient({
      vacancy: {
        data: { ...defaultVacancyRow, company_id: null, salary_min: null, salary_max: null, salary_source: null, source_code: "adzuna" },
        error: null,
      },
    });

    const result = await scoreVacancy(client, "vacancy-1", deps);

    expect(result.status).toBe("UNDER_REVIEW");
    expect(deps.enqueueFitJobs).toHaveBeenCalledWith(client, "vacancy-1");
  });

  it("enqueues fit analysis when a vacancy LEAVES VERIFIED", async () => {
    const { client, deps } = makeClient({
      vacancy: {
        data: {
          ...defaultVacancyRow,
          trust_status: "VERIFIED",
          company_id: null,
          salary_min: null,
          salary_max: null,
          salary_source: null,
          source_code: "adzuna",
        },
        error: null,
      },
    });

    const result = await scoreVacancy(client, "vacancy-1", deps);

    expect(result.status).toBe("UNDER_REVIEW");
    expect(deps.enqueueFitJobs).toHaveBeenCalledWith(client, "vacancy-1");
  });

  it("does NOT re-enqueue when the bucket is unchanged (scoreVacancy runs every ingestion pass)", async () => {
    const { client, deps } = makeClient({
      vacancy: {
        data: {
          ...defaultVacancyRow,
          trust_status: "UNDER_REVIEW",
          company_id: null,
          salary_min: null,
          salary_max: null,
          salary_source: null,
          source_code: "adzuna",
        },
        error: null,
      },
    });

    const result = await scoreVacancy(client, "vacancy-1", deps);

    expect(result.status).toBe("UNDER_REVIEW");
    expect(deps.enqueueFitJobs).not.toHaveBeenCalled();
  });

  it("a failing fit enqueue never breaks scoring", async () => {
    const { client, deps } = makeClient();
    deps.enqueueFitJobs.mockRejectedValueOnce(new Error("queue down"));

    const result = await scoreVacancy(client, "vacancy-1", deps);

    expect(result.status).toBe("VERIFIED");
  });

  it("returns BLOCKED and delegates to applyHardBlocks's write path when a hard block fires, without computing a score", async () => {
    const { client, from, trustScoreBuilder } = makeClient({
      vacancy: { data: { ...defaultVacancyRow, status: "removed" }, error: null },
    });

    const result = await scoreVacancy(client, "vacancy-1");

    expect(result).toEqual({ status: "BLOCKED", reasonCodes: ["VACANCY_REMOVED"] });

    // applyHardBlocks writes a BLOCKED row via the same "vacancy_trust_scores" table.
    expect(trustScoreBuilder.calls[0]).toEqual({
      method: "insert",
      args: [{ vacancy_id: "vacancy-1", status: "BLOCKED", score: null, policy_version: "r3-hard-block-v1" }],
    });
    expect(from).toHaveBeenCalledWith("vacancy_trust_scores");
  });

  it("skips the company lookup and scores identity as unverified when the vacancy has no company_id", async () => {
    const { client, from } = makeClient({
      vacancy: { data: { ...defaultVacancyRow, company_id: null }, error: null },
    });

    const result = await scoreVacancy(client, "vacancy-1");

    expect(from).not.toHaveBeenCalledWith("companies");
    expect(result.status).not.toBe("VERIFIED");
    if (result.status !== "BLOCKED") {
      expect(result.reasonCodes).not.toContain("OFFICIAL_CAREER_PAGE_CONFIRMED");
      expect(result.reasonCodes).not.toContain("CORPORATE_DOMAIN_CONFIRMED");
    }
  });

  it("throws when the vacancy is not found", async () => {
    const { client } = makeClient({ vacancy: { data: null, error: null } });
    await expect(scoreVacancy(client, "missing-vacancy")).rejects.toBeTruthy();
  });

  it("throws when the company lookup fails", async () => {
    const { client } = makeClient({ company: { data: null, error: { message: "not found" } } });
    await expect(scoreVacancy(client, "vacancy-1")).rejects.toBeTruthy();
  });

  it("throws when the source_policies lookup fails", async () => {
    const { client } = makeClient({ policy: { data: null, error: null } });
    await expect(scoreVacancy(client, "vacancy-1")).rejects.toBeTruthy();
  });

  it("scores UNDER_REVIEW when identity/salary are unverifiable but nothing hard-blocks", async () => {
    // A *mismatched* domain would itself trigger the DOMAIN_MISMATCH_WITH_NO_EXPLANATION
    // hard block (evaluateHardBlocks runs the same check) — this case is
    // deliberately "no company data at all" instead, which is the one way
    // employerIdentity can score 0 without also hard-blocking (the
    // hard-block domain check only runs when knownDomains.length > 0).
    const { client } = makeClient({
      vacancy: {
        data: {
          ...defaultVacancyRow,
          company_id: null,
          salary_min: null,
          salary_max: null,
          salary_source: null,
          source_code: "adzuna",
        },
        error: null,
      },
    });

    const result = await scoreVacancy(client, "vacancy-1");

    // employerIdentity=0, authoritativeSource=1(20), urlIntegrity=1(15, no
    // domain data to penalize against), freshness=1(10),
    // contentConsistency=0.5(5), moderatorHistory=0.5(5),
    // salaryPlausibility=0.5(2.5), scamSignals=0.5(5) = 62.5 -> rounds to
    // 63 -> UNDER_REVIEW
    expect(result.status).toBe("UNDER_REVIEW");
    if (result.status !== "BLOCKED") {
      expect(result.score).toBe(63);
    }
  });
});

describe("resolveStatus — the partial-verification rule", () => {
  it("relabels an UNDER_REVIEW score as VERIFIED_INCOMPLETE when the source declares partial verification", () => {
    expect(resolveStatus("UNDER_REVIEW", true)).toBe("VERIFIED_INCOMPLETE");
  });

  it("leaves UNDER_REVIEW alone when the source has not declared it", () => {
    expect(resolveStatus("UNDER_REVIEW", false)).toBe("UNDER_REVIEW");
  });

  it("NEVER upgrades a FLAGGED score, whatever the source declares", () => {
    // The line that matters. FLAGGED means the score itself found something
    // wrong; a source-level declaration suppresses an "unproven" label, it does
    // not turn a negative finding into an eligible listing.
    expect(resolveStatus("FLAGGED", true)).toBe("FLAGGED");
    expect(resolveStatus("FLAGGED", false)).toBe("FLAGGED");
  });

  it("NEVER downgrades a VERIFIED score", () => {
    // A source's own modesty cannot take away a status the vacancy's score
    // earned.
    expect(resolveStatus("VERIFIED", true)).toBe("VERIFIED");
    expect(resolveStatus("VERIFIED", false)).toBe("VERIFIED");
  });

  it("is a no-op for every status when the flag is off, so no existing source changes behaviour", () => {
    for (const status of ["VERIFIED", "VERIFIED_INCOMPLETE", "UNDER_REVIEW", "FLAGGED"] as const) {
      expect(resolveStatus(status, false)).toBe(status);
    }
  });
});

describe("scoreVacancy — partial verification sources", () => {
  // The aggregator shape: aggregator-owned URL, no company domain, so
  // employerIdentity scores 0 and 65 is the ceiling against a VERIFIED
  // threshold of 80. This is Remotive's shape.
  const aggregatorVacancy = {
    ...defaultVacancyRow,
    authoritative_url: "https://www.usajobs.gov:443/job/759326100",
    company_id: null,
    source_code: "remotive",
  };

  it("records VERIFIED_INCOMPLETE when the source allows it", async () => {
    const { client, deps } = makeClient({
      vacancy: { data: aggregatorVacancy, error: null },
      policy: { data: { ...defaultPolicy, partial_verification_allowed: true }, error: null },
    });

    const result = await scoreVacancy(client, "vacancy-1", deps);

    expect(result.status).toBe("VERIFIED_INCOMPLETE");
    if (result.status !== "BLOCKED") {
      expect(result.score).toBe(65);
    }
  });

  it("writes that one status to BOTH tables, which is the whole point", async () => {
    // Before Task Y, intake recorded UNDER_REVIEW in vacancy_trust_scores and
    // then overwrote vacancies.trust_status with VERIFIED_INCOMPLETE, leaving
    // two tables disagreeing about one fact.
    const { client, deps, trustScoreBuilder, vacancyUpdateBuilder } = makeClient({
      vacancy: { data: aggregatorVacancy, error: null },
      policy: { data: { ...defaultPolicy, partial_verification_allowed: true }, error: null },
    });

    await scoreVacancy(client, "vacancy-1", deps);

    const scoreInsert = trustScoreBuilder.calls.find((call) => call.method === "insert");
    expect(scoreInsert?.args[0]).toMatchObject({ vacancy_id: "vacancy-1", status: "VERIFIED_INCOMPLETE", score: 65 });

    const statusUpdate = vacancyUpdateBuilder.calls.find(
      (call) => call.method === "update" && typeof call.args[0] === "object" && call.args[0] !== null,
    );
    expect(statusUpdate?.args[0]).toEqual({ trust_status: "VERIFIED_INCOMPLETE" });
  });

  it("does not relabel a vacancy that earned VERIFIED", async () => {
    const { client, deps } = makeClient({
      policy: { data: { ...defaultPolicy, partial_verification_allowed: true }, error: null },
    });

    const result = await scoreVacancy(client, "vacancy-1", deps);

    expect(result.status).toBe("VERIFIED");
  });

  it("leaves sources without the declaration on UNDER_REVIEW, unchanged", async () => {
    // Jooble's 125 rows depend on this: they are genuinely unverifiable
    // scraped listings, not merely incomplete ones.
    const { client, deps, vacancyUpdateBuilder } = makeClient({
      vacancy: { data: { ...aggregatorVacancy, source_code: "jooble" }, error: null },
    });

    const result = await scoreVacancy(client, "vacancy-1", deps);

    expect(result.status).toBe("UNDER_REVIEW");
    const statusUpdate = vacancyUpdateBuilder.calls.find(
      (call) => call.method === "update" && typeof call.args[0] === "object" && call.args[0] !== null,
    );
    expect(statusUpdate?.args[0]).toEqual({ trust_status: "UNDER_REVIEW" });
  });

  it("enqueues fit analysis on the transition into VERIFIED_INCOMPLETE", async () => {
    const { client, deps } = makeClient({
      vacancy: { data: aggregatorVacancy, error: null },
      policy: { data: { ...defaultPolicy, partial_verification_allowed: true }, error: null },
    });

    await scoreVacancy(client, "vacancy-1", deps);

    expect(deps.enqueueFitJobs).toHaveBeenCalledWith(client, "vacancy-1");
  });
});
