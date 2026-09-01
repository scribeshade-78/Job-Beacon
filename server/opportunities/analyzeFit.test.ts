import { describe, expect, it, vi } from "vitest";
import { analyzeFit } from "./analyzeFit.js";
import { FIT_DIMENSIONS, type RawFitAnalysis } from "./fitPrompt.js";
import { FACTOR_WEIGHTS, PRIORITY_SCORE_VERSION } from "../../shared/priorityScore.js";

function fitPayload(): RawFitAnalysis {
  const components = Object.fromEntries(
    FIT_DIMENSIONS.map((d) => [d, { score: 65, rationale: `r ${d}` }]),
  ) as RawFitAnalysis["components"];
  return { overall: 68, components, missing_evidence: ["Terraform"], top_reasons: ["Good match"], risks: [] };
}

function openaiFake(payload: RawFitAnalysis = fitPayload()) {
  const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(payload) } }] });
  return { create, deps: { openai: { chat: { completions: { create } } } as never } };
}

/** Minimal chainable/thenable builder with per-call terminal results. */
function builder(terminals: { await?: unknown; maybeSingle?: unknown; single?: unknown }) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "limit", "insert", "upsert", "update"]) {
    b[m] = () => b;
  }
  b.maybeSingle = () => terminals.maybeSingle ?? { data: null, error: null };
  b.single = () => terminals.single ?? { data: null, error: null };
  b.then = (resolve: (v: unknown) => void) => resolve(terminals.await ?? { data: [], error: null });
  return b as never;
}

interface ClientOpts {
  vacancy?: unknown;
  facts?: unknown[];
  confirmations?: unknown[];
  version?: unknown;
  existingSnapshot?: unknown;
  insertedSnapshotId?: string;
  /** Phase 2.3b priority inputs. */
  trustScore?: number | null;
  applicationPlan?: unknown;
  selectedRoles?: unknown[];
  existingAnalysis?: unknown;
}

function makeClient(opts: ClientOpts) {
  const counts: Record<string, number> = {};

  const from = vi.fn((table: string) => {
    counts[table] = (counts[table] ?? 0) + 1;

    if (table === "vacancies") {
      return builder({ maybeSingle: { data: opts.vacancy ?? null, error: null } });
    }
    if (table === "extracted_facts") {
      return builder({ await: { data: opts.facts ?? [], error: null } });
    }
    if (table === "fact_confirmations") {
      return builder({ await: { data: opts.confirmations ?? [], error: null } });
    }
    if (table === "vacancy_versions") {
      return builder({ maybeSingle: { data: opts.version ?? null, error: null } });
    }
    if (table === "vacancy_jd_snapshots") {
      // 1st call = existence check (.maybeSingle), 2nd = insert (.single)
      if (counts[table] === 1) {
        return builder({ maybeSingle: { data: opts.existingSnapshot ?? null, error: null } });
      }
      return builder({ single: { data: { id: opts.insertedSnapshotId ?? "snap-new" }, error: null } });
    }
    if (table === "fit_analyses") {
      // Read-only here: the previous analysis, for the AI-skip guard. The
      // upsert is fitWorker's job, not analyzeFit's.
      return builder({ maybeSingle: { data: opts.existingAnalysis ?? null, error: null } });
    }
    if (table === "vacancy_trust_scores") {
      const score = opts.trustScore ?? null;
      return builder({ maybeSingle: { data: score === null ? null : { score }, error: null } });
    }
    if (table === "application_plans") {
      return builder({ maybeSingle: { data: opts.applicationPlan ?? null, error: null } });
    }
    if (table === "candidate_selected_roles") {
      return builder({ await: { data: opts.selectedRoles ?? [], error: null } });
    }
    throw new Error(`unexpected table ${table}`);
  });

  return { client: { from } as never };
}

const VACANCY = {
  id: "vac-1",
  raw_title: "Senior Platform Engineer",
  source_code: "greenhouse",
  country: "India",
  region: null,
  city: null,
  remote_type: "on_site",
  salary_min: null,
  salary_max: null,
  salary_source: null,
  expires_at: null,
};

const CONFIRMED_LOCATION = {
  facts: [{ id: "f1", fact_type: "location", fact_value: "Bengaluru, India" }],
  confirmations: [{ extracted_fact_id: "f1", corrected_value: null }],
};

const GREENHOUSE_VERSION = {
  id: "ver-1",
  raw_payload: { absolute_url: "https://x/1", content: "&lt;h3&gt;Duties&lt;/h3&gt;&lt;p&gt;Build platforms.&lt;/p&gt;" },
};

describe("analyzeFit", () => {
  it("happy path: JD text present -> Technical Fit populated, jd_text_available true", async () => {
    const { client } = makeClient({
      vacancy: VACANCY,
      facts: [{ id: "f1", fact_type: "location", fact_value: "Bengaluru, India" }, { id: "f2", fact_type: "skill", fact_value: "Go" }],
      confirmations: [{ extracted_fact_id: "f1", corrected_value: null }, { extracted_fact_id: "f2", corrected_value: null }],
      version: GREENHOUSE_VERSION,
    });
    const { deps, create } = openaiFake();

    const row = await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(create).toHaveBeenCalledOnce();
    expect(row.jd_text_available).toBe(true);
    expect(row.jd_snapshot_id).toBe("snap-new");
    expect(row.technical_fit_score).toBe(68);
    expect(row.missing_evidence).toEqual(["Terraform"]);
    expect(row.practical_eligibility_score).toBe(100); // same country, on_site
    expect(row.eligibility_capped).toBe(false);
    expect(row.prompt_version).toBe("fit-analysis-v1");
  });

  it("LOCATION_PRESENCE: practical score capped to 0, eligibility_capped true, Technical Fit still populated", async () => {
    const { client } = makeClient({
      vacancy: { ...VACANCY, country: "United States" },
      facts: [{ id: "f1", fact_type: "location", fact_value: "Bengaluru, India" }],
      confirmations: [{ extracted_fact_id: "f1", corrected_value: null }],
      version: GREENHOUSE_VERSION,
    });
    const { deps } = openaiFake();

    const row = await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(row.practical_eligibility_score).toBe(0);
    expect(row.eligibility_capped).toBe(true);
    expect(row.hard_blockers[0].code).toBe("LOCATION_PRESENCE");
    expect(row.technical_fit_score).toBe(68);
    expect(row.jd_text_available).toBe(true);
  });

  it("no JD text: skips the AI call, jd_text_available false, technical fit null, still computes eligibility", async () => {
    const { client } = makeClient({
      vacancy: VACANCY,
      facts: [{ id: "f1", fact_type: "location", fact_value: "Bengaluru, India" }],
      confirmations: [{ extracted_fact_id: "f1", corrected_value: null }],
      version: { id: "ver-2", raw_payload: { PositionTitle: "x" } }, // usajobs-less payload -> empty extract... but source is greenhouse w/ no content
    });
    const { deps, create } = openaiFake();

    const row = await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(create).not.toHaveBeenCalled();
    expect(row.jd_text_available).toBe(false);
    expect(row.jd_snapshot_id).toBeNull();
    expect(row.technical_fit_score).toBeNull();
    expect(row.technical_fit_components).toBeNull();
    expect(row.practical_eligibility_score).toBe(100);
  });

  it("no vacancy_versions row at all: treated as no JD text", async () => {
    const { client } = makeClient({
      vacancy: VACANCY,
      facts: [{ id: "f1", fact_type: "location", fact_value: "Bengaluru, India" }],
      confirmations: [{ extracted_fact_id: "f1", corrected_value: null }],
      version: null,
    });
    const { deps } = openaiFake();

    const row = await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });
    expect(row.jd_text_available).toBe(false);
  });

  it("uses corrected_value over fact_value for the location fact", async () => {
    const { client } = makeClient({
      vacancy: { ...VACANCY, country: "United States" },
      facts: [{ id: "f1", fact_type: "location", fact_value: "Bengaluru, India" }],
      confirmations: [{ extracted_fact_id: "f1", corrected_value: "Austin, Texas, USA" }],
      version: GREENHOUSE_VERSION,
    });
    const { deps } = openaiFake();

    const row = await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });
    expect(row.eligibility_capped).toBe(false); // corrected location is in the US
    expect(row.practical_eligibility_score).toBe(100);
  });

  it("only confirmed facts count: an unconfirmed location fact yields INSUFFICIENT_DATA", async () => {
    const { client } = makeClient({
      vacancy: { ...VACANCY, country: "United States" },
      facts: [{ id: "f1", fact_type: "location", fact_value: "Bengaluru, India" }],
      confirmations: [], // none confirmed
      version: GREENHOUSE_VERSION,
    });
    const { deps } = openaiFake();

    const row = await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });
    expect(row.practical_eligibility_score).toBeNull();
    expect(row.hard_blockers).toEqual([]);
    expect(row.soft_penalties).toEqual([]);
  });

  it("propagates a malformed AI output as a throw (worker will retry)", async () => {
    const { client } = makeClient({
      vacancy: VACANCY,
      facts: [{ id: "f1", fact_type: "location", fact_value: "Bengaluru, India" }],
      confirmations: [{ extracted_fact_id: "f1", corrected_value: null }],
      version: GREENHOUSE_VERSION,
    });
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: "{not valid}" } }] });
    const deps = { openai: { chat: { completions: { create } } } as never };

    await expect(analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" })).rejects.toBeTruthy();
  });
});

describe("analyzeFit — Phase 2.3b stored priority score", () => {
  function base(over: ClientOpts = {}) {
    return makeClient({ vacancy: VACANCY, ...CONFIRMED_LOCATION, version: GREENHOUSE_VERSION, ...over });
  }

  it("returns a versioned, stored-shaped priority score", async () => {
    const { client } = base();
    const { deps } = openaiFake();

    const row = await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(row.priority_score_version).toBe(PRIORITY_SCORE_VERSION);
    expect(row.priority_score).toBeGreaterThanOrEqual(0);
    expect(row.priority_score).toBeLessThanOrEqual(100);
    expect(row.priority_uncapped_score).toBe(row.priority_score);
    expect(Object.keys(row.priority_components!).sort()).toEqual(Object.keys(FACTOR_WEIGHTS).sort());
  });

  it("wires company_credibility from the latest vacancy_trust_scores row", async () => {
    const { client } = base({ trustScore: 92 });
    const { deps } = openaiFake();

    const row = await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(row.priority_components!.company_credibility).toEqual({ weight: 0.05, value: 92, source: "fit" });
  });

  it("leaves company_credibility neutral when the vacancy has never been scored", async () => {
    const { client } = base({ trustScore: null });
    const { deps } = openaiFake();

    const row = await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(row.priority_components!.company_credibility.source).toBe("neutral");
  });

  it("an application with no classified reply reads as Submitted (40)", async () => {
    const { client } = base({ applicationPlan: { id: "plan-1", application_attempts: [] } });
    const { deps } = openaiFake();

    const row = await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(row.priority_components!.response_stage).toEqual({ weight: 0.25, value: 40, source: "fit" });
  });

  it("uses the latest classification reached through the application chain", async () => {
    const { client } = base({
      applicationPlan: {
        id: "plan-1",
        application_attempts: [
          {
            messages: [
              {
                response_classifications: [
                  { category: "recruiter_followup", classified_at: "2026-02-01T00:00:00Z", extracted_deadline: null },
                ],
              },
              {
                response_classifications: [
                  { category: "offer", classified_at: "2026-03-01T00:00:00Z", extracted_deadline: null },
                ],
              },
            ],
          },
        ],
      },
    });
    const { deps } = openaiFake();

    const row = await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(row.priority_components!.response_stage.value).toBe(100);
  });

  it("tolerates PostgREST returning to-one embeds as objects rather than arrays", async () => {
    const { client } = base({
      applicationPlan: {
        id: "plan-1",
        application_attempts: {
          messages: {
            response_classifications: {
              category: "interview",
              classified_at: "2026-03-01T00:00:00Z",
              extracted_deadline: null,
            },
          },
        },
      },
    });
    const { deps } = openaiFake();

    const row = await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(row.priority_components!.response_stage.value).toBe(85);
  });

  it("an unknown classification category falls back to neutral rather than guessing", async () => {
    const { client } = base({
      applicationPlan: {
        id: "plan-1",
        application_attempts: [
          {
            messages: [
              {
                response_classifications: [
                  { category: "screening_call", classified_at: "2026-03-01T00:00:00Z", extracted_deadline: null },
                ],
              },
            ],
          },
        ],
      },
    });
    const { deps } = openaiFake();

    const row = await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    // An application still exists, so the Submitted floor applies.
    expect(row.priority_components!.response_stage.value).toBe(40);
  });

  it("matches a selected role against the vacancy title", async () => {
    const { client } = base({ selectedRoles: [{ role_name: "platform engineer" }] });
    const { deps } = openaiFake();

    const row = await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(row.priority_components!.user_preferences).toEqual({ weight: 0.05, value: 100, source: "fit" });
  });

  it("selected roles that do not match score 50 but count as a real signal", async () => {
    const { client } = base({ selectedRoles: [{ role_name: "Staff Designer" }] });
    const { deps } = openaiFake();

    const row = await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(row.priority_components!.user_preferences).toEqual({ weight: 0.05, value: 50, source: "fit" });
  });

  it("wires employment_arrangement and compensation_quality from the vacancy row", async () => {
    const { client } = base({
      vacancy: { ...VACANCY, remote_type: "remote", salary_min: 60000, salary_max: 80000, salary_source: "employer_disclosed" },
    });
    const { deps } = openaiFake();

    const row = await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(row.priority_components!.employment_arrangement.value).toBe(100);
    expect(row.priority_components!.compensation_quality.value).toBe(90);
  });

  it("snapshots urgency from expires_at", async () => {
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const { client } = base({ vacancy: { ...VACANCY, expires_at: soon } });
    const { deps } = openaiFake();

    const row = await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(row.priority_components!.urgency).toEqual({ weight: 0.05, value: 100, source: "fit" });
  });

  it("a hard-blocked analysis stores priority_score 0 with a positive uncapped score", async () => {
    const { client } = base({ vacancy: { ...VACANCY, country: "United States" } });
    const { deps } = openaiFake();

    const row = await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(row.eligibility_capped).toBe(true);
    expect(row.priority_score).toBe(0);
    expect(row.priority_uncapped_score).toBeGreaterThan(0);
  });
});

describe("analyzeFit — Phase 2.3b AI-skip guard", () => {
  const SNAPSHOT = { id: "snap-1", clean_text: "Build platforms.", sections: [{ heading: "Duties" }] };

  function existingAnalysis(over: Record<string, unknown> = {}) {
    return {
      jd_snapshot_id: "snap-1",
      analyzed_at: "2026-03-01T00:00:00Z",
      technical_fit_score: 55,
      technical_fit_components: { core_technical_skills: { score: 55, rationale: "stored" } },
      missing_evidence: ["Kubernetes"],
      top_reasons: ["stored reason"],
      risks: ["stored risk"],
      model_version: "openai/gpt-4o-mini-OLD",
      prompt_version: "fit-analysis-v1",
      ...over,
    };
  }

  function guardClient(over: ClientOpts = {}) {
    return makeClient({
      vacancy: VACANCY,
      ...CONFIRMED_LOCATION,
      version: GREENHOUSE_VERSION,
      existingSnapshot: SNAPSHOT,
      existingAnalysis: existingAnalysis(),
      ...over,
    });
  }

  it("reuses the stored Technical Fit and skips the AI call when nothing it depends on changed", async () => {
    const { client } = guardClient();
    const { deps, create } = openaiFake();

    const row = await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(create).not.toHaveBeenCalled();
    expect(row.technical_fit_score).toBe(55);
    expect(row.missing_evidence).toEqual(["Kubernetes"]);
    expect(row.top_reasons).toEqual(["stored reason"]);
    expect(row.risks).toEqual(["stored risk"]);
    // The reused output keeps reporting the model that actually produced it.
    expect(row.model_version).toBe("openai/gpt-4o-mini-OLD");
  });

  it("still recomputes Practical Eligibility and the priority score when skipping the AI", async () => {
    const { client } = guardClient({ trustScore: 88, selectedRoles: [{ role_name: "platform engineer" }] });
    const { deps, create } = openaiFake();

    const row = await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(create).not.toHaveBeenCalled();
    expect(row.practical_eligibility_score).toBe(100);
    expect(row.priority_components!.company_credibility.value).toBe(88);
    expect(row.priority_components!.user_preferences.value).toBe(100);
    expect(row.priority_score_version).toBe(PRIORITY_SCORE_VERSION);
  });

  it("re-runs the AI when the JD snapshot changed", async () => {
    const { client } = guardClient({ existingAnalysis: existingAnalysis({ jd_snapshot_id: "snap-OLD" }) });
    const { deps, create } = openaiFake();

    const row = await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(create).toHaveBeenCalledOnce();
    expect(row.technical_fit_score).toBe(68);
  });

  it("re-runs the AI when the prompt version was bumped", async () => {
    const { client } = guardClient({ existingAnalysis: existingAnalysis({ prompt_version: "fit-analysis-v0" }) });
    const { deps, create } = openaiFake();

    await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(create).toHaveBeenCalledOnce();
  });

  it("re-runs the AI when a fact confirmation is newer than the stored analysis", async () => {
    const { client } = guardClient({
      confirmations: [{ extracted_fact_id: "f1", corrected_value: null, updated_at: "2026-04-01T00:00:00Z" }],
    });
    const { deps, create } = openaiFake();

    await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(create).toHaveBeenCalledOnce();
  });

  it("does not re-run the AI for a confirmation older than the stored analysis", async () => {
    const { client } = guardClient({
      confirmations: [{ extracted_fact_id: "f1", corrected_value: null, updated_at: "2026-01-01T00:00:00Z" }],
    });
    const { deps, create } = openaiFake();

    await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(create).not.toHaveBeenCalled();
  });

  it("re-runs the AI when the stored analysis has no Technical Fit to reuse", async () => {
    const { client } = guardClient({ existingAnalysis: existingAnalysis({ technical_fit_score: null }) });
    const { deps, create } = openaiFake();

    await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(create).toHaveBeenCalledOnce();
  });

  it("runs the AI when there is no previous analysis at all", async () => {
    const { client } = guardClient({ existingAnalysis: null });
    const { deps, create } = openaiFake();

    await analyzeFit(client, deps, { candidateId: "cand-1", vacancyId: "vac-1" });

    expect(create).toHaveBeenCalledOnce();
  });
});
