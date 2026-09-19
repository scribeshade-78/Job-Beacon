/**
 * Clipboard write with an explicit success/failure result.
 *
 * navigator.clipboard only exists in a secure context and its writeText can
 * still be rejected by permissions policy, so the failure mode is ordinary
 * rather than exotic. Returning a result instead of throwing keeps the
 * caller's decision ("which toast do I show?") separate from the mechanism,
 * and makes both branches testable without a DOM.
 */
export type CopyToClipboardResult = { kind: "success" } | { kind: "error" };

export async function copyToClipboard(
  text: string,
  clipboard: Pick<Clipboard, "writeText"> | undefined = globalThis.navigator?.clipboard,
): Promise<CopyToClipboardResult> {
  try {
    if (!clipboard || typeof clipboard.writeText !== "function") {
      return { kind: "error" };
    }

    await clipboard.writeText(text);
    return { kind: "success" };
  } catch {
    return { kind: "error" };
  }
}
