/**
 * Mailbox addresses, parsed and formatted strictly.
 *
 * WHY THIS IS ITS OWN MODULE. Two rules depend on it and neither can afford a second, slightly
 * different implementation: the outbound send must write only to an address an employer actually
 * wrote FROM, and the From header we emit must not be injectable. Both are string operations on
 * headers, which is exactly where "close enough" quietly becomes a security bug.
 */

/** RFC 5322 atext plus the dot: enough for a local part, and deliberately without whitespace. */
const LOCAL_PART = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+";
const DOMAIN_PART = "[A-Za-z0-9.-]+\\.[A-Za-z]{2,}";
const ADDRESS_PATTERN = new RegExp("^" + LOCAL_PART + "@" + DOMAIN_PART + "$");

/** Header injection: any CR/LF in a header value splits it into a second header. */
const HEADER_BREAK = /[\r\n]/;

/**
 * The single address a header names, or null.
 *
 * TAKES THE ANGLE-BRACKET CONTENT when present, because that is the actual mailbox; the text
 * before it is a display name and is discarded. A header naming more than one mailbox returns
 * null rather than "the first one": choosing a recipient out of a list is how mail goes to the
 * wrong place, and the caller can only see one address here anyway.
 */
export function parseMailboxAddress(header: string | null | undefined): string | null {
  if (typeof header !== "string") {
    return null;
  }

  const trimmed = header.trim();

  if (trimmed === "" || HEADER_BREAK.test(trimmed)) {
    return null;
  }

  const angle = trimmed.match(/<([^<>]*)>/);
  const candidate = (angle ? angle[1]! : trimmed).trim();

  if (candidate === "" || HEADER_BREAK.test(candidate)) {
    return null;
  }

  // A comma or semicolon means a list survived here; refuse rather than pick one.
  if (/[,;]/.test(candidate)) {
    return null;
  }

  return ADDRESS_PATTERN.test(candidate) ? candidate : null;
}

/**
 * Formats a mailbox for a header, quoting a display name that would otherwise change its meaning.
 *
 * A name containing a quote, comma, angle bracket or line break must be quoted and escaped,
 * otherwise it terminates the header value early — the same class of bug as accepting CR/LF.
 */
export function formatMailbox(name: string | null | undefined, address: string): string {
  const cleanAddress = address.trim();
  const display = typeof name === "string" ? name.trim() : "";

  if (display === "") {
    return cleanAddress;
  }

  if (HEADER_BREAK.test(display)) {
    throw new Error("A display name must not contain a line break.");
  }

  if (!/["(),:;<>@\\]/.test(display)) {
    return display + " <" + cleanAddress + ">";
  }

  return '"' + display.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '" <' + cleanAddress + ">";
}
