import { describe, expect, it } from "vitest";
import { chunkIds, READ_CHUNK_SIZE } from "./pgrestChunk.js";

describe("chunkIds", () => {
  it("defaults to the measured-safe chunk size", () => {
    // 100 ids is about 3.9 KB of query string. The limit this exists for is a URI, not a
    // page size, so the number is a URL-length bound rather than a tuning knob.
    expect(READ_CHUNK_SIZE).toBe(100);
  });

  it("returns nothing for an empty list, so no request is made", () => {
    expect(chunkIds([])).toEqual([]);
  });

  it("returns one chunk when the list fits", () => {
    expect(chunkIds(["a", "b"])).toEqual([["a", "b"]]);
  });

  it("splits at the boundary and keeps the remainder", () => {
    const values = Array.from({ length: 250 }, (_, i) => i);
    const chunks = chunkIds(values);

    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
    // Nothing lost and nothing duplicated, which is the property that matters: a dropped id
    // would silently under-report and a duplicated one would double-count.
    expect(chunks.flat()).toEqual(values);
  });

  it("does not emit a trailing empty chunk on an exact multiple", () => {
    expect(chunkIds(Array.from({ length: 200 }, (_, i) => i)).map((c) => c.length)).toEqual([100, 100]);
  });
});
