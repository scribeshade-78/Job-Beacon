import { describe, expect, it, vi } from "vitest";
import { analyzeFit } from "./analyzeFit.js";
import { FIT_DIMENSIONS, type RawFitAnalysis } from "./fitPrompt.js";

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
}

function makeClient(opts: ClientOpts) {
  const counts: Record<string, number> = {};
  const upserts: unknown[] = [];

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
      const b = builder({ await: { error: null } });
      (b as unknown as { upsert: (v: unknown) => unknown }).upsert = (v: unknown) => {
        upserts.push(v);
        return b;
      };
      return b;
    }
    throw new Error(`unexpected table ${table}`);
  });

  return { client: { from } as never, upserts };
}

const VACANCY = {
  id: "vac-1",
  raw_title: "Senior Platform Engineer",
  source_code: "greenhouse",
  country: "India",
  region: null,
  city: null,
  remote_type: "on_site",
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
