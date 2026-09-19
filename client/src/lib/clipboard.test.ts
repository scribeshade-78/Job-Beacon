import { describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "./clipboard";

describe("copyToClipboard", () => {
  it("reports success and writes the exact text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    const result = await copyToClipboard("https://api.jobbeacon.local/mcp", { writeText });

    expect(result).toEqual({ kind: "success" });
    expect(writeText).toHaveBeenCalledWith("https://api.jobbeacon.local/mcp");
  });

  it("reports failure when the Clipboard API is unavailable", async () => {
    // Non-secure context, or a browser that does not expose it at all.
    expect(await copyToClipboard("x", undefined)).toEqual({ kind: "error" });
  });

  it("reports failure when writeText is not a function", async () => {
    expect(await copyToClipboard("x", {} as never)).toEqual({ kind: "error" });
  });

  it("reports failure when the write is rejected by permissions policy", async () => {
    // The case the UI must not report as success.
    const writeText = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));

    expect(await copyToClipboard("x", { writeText })).toEqual({ kind: "error" });
  });

  it("never throws, whatever the clipboard does", async () => {
    const writeText = vi.fn(() => {
      throw new Error("sync boom");
    });

    await expect(copyToClipboard("x", { writeText })).resolves.toEqual({ kind: "error" });
  });
});
