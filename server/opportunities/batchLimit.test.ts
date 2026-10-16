import { describe, expect, it } from "vitest";
import {
  DEFAULT_FIT_ANALYSIS_BATCH_LIMIT,
  MAX_FIT_ANALYSIS_BATCH_LIMIT,
  readFitAnalysisBatchLimit,
} from "./batchLimit.js";

describe("readFitAnalysisBatchLimit", () => {
  it("defaults to 50 when unset, so an unconfigured deployment is still metered", () => {
    expect(DEFAULT_FIT_ANALYSIS_BATCH_LIMIT).toBe(50);
    expect(readFitAnalysisBatchLimit({})).toBe(50);
  });

  it("honours an explicit smaller limit", () => {
    expect(readFitAnalysisBatchLimit({ FIT_ANALYSIS_BATCH_LIMIT: "10" })).toBe(10);
  });

  it("CLAMPS a larger limit to the ceiling, so no configuration can uncap the drain", () => {
    // THE POINT OF THE CEILING. A throttle that a config file can raise without limit is not
    // a throttle - and every fit analysis is a paid model call. 200 is one fan-out's worth
    // (the vacancy cap), so a single tick can never spend more than one candidate action
    // queued, however the environment is set.
    expect(MAX_FIT_ANALYSIS_BATCH_LIMIT).toBe(200);
    expect(readFitAnalysisBatchLimit({ FIT_ANALYSIS_BATCH_LIMIT: "100000" })).toBe(200);
    expect(readFitAnalysisBatchLimit({ FIT_ANALYSIS_BATCH_LIMIT: "201" })).toBe(200);
    expect(readFitAnalysisBatchLimit({ FIT_ANALYSIS_BATCH_LIMIT: "200" })).toBe(200);
  });

  it("falls back to the default for an unparseable, empty or negative value", () => {
    expect(readFitAnalysisBatchLimit({ FIT_ANALYSIS_BATCH_LIMIT: "lots" })).toBe(
      DEFAULT_FIT_ANALYSIS_BATCH_LIMIT,
    );
    expect(readFitAnalysisBatchLimit({ FIT_ANALYSIS_BATCH_LIMIT: "-5" })).toBe(
      DEFAULT_FIT_ANALYSIS_BATCH_LIMIT,
    );
    expect(readFitAnalysisBatchLimit({ FIT_ANALYSIS_BATCH_LIMIT: "" })).toBe(
      DEFAULT_FIT_ANALYSIS_BATCH_LIMIT,
    );
  });

  it("treats 0 as a deliberate pause of the paid drain", () => {
    // readEnvInt honours 0, and for a batch limit that means "claim nothing": a way to stop
    // spending model money without disabling the task or unsetting the API key.
    expect(readFitAnalysisBatchLimit({ FIT_ANALYSIS_BATCH_LIMIT: "0" })).toBe(0);
  });
});
