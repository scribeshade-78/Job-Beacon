import { describe, expect, it, vi } from "vitest";
import { scoreVacancy } from "./scoreVacancy.js";

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

  return {
    client: { from } as unknown as Parameters<typeof scoreVacancy>[0],
    from,
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
    const { client, trustScoreBuilder, flagsBuilder, vacancyUpdateBuilder } = makeClient();

    const result = await scoreVacancy(client, "vacancy-1");

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
      args: [{ vacancy_id: "vacancy-1", status: "VERIFIED", score: 85, policy_version: "r3-trust-score-v1" }],
    });

    const insertedFlags = flagsBuilder.calls[0].args[0] as Array<{ vacancy_trust_score_id: string; reason_code: string }>;
    expect(insertedFlags).toHaveLength(5);
    expect(insertedFlags.every((flag) => flag.vacancy_trust_score_id === "score-1")).toBe(true);

    expect(vacancyUpdateBuilder.calls[0]).toEqual({ method: "update", args: [{ trust_status: "VERIFIED" }] });
    expect(vacancyUpdateBuilder.calls[1]).toEqual({ method: "eq", args: ["id", "vacancy-1"] });
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
