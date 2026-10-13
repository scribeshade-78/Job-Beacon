/**
 * authoritative_url has no scheme constraint at the DB level and is
 * populated from external, scraped job sources — rendering it into an
 * href unchecked would let a malicious source-side value (e.g. a
 * javascript: URL) execute on click. http(s)-only allowlist, same
 * discipline as resume.ts's isSupportedMimeType.
 */
export function safeVacancyHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : "#";
}

/**
 * Tags a job-board URL with the attempt the extension should prepare a form for.
 *
 * IT RUNS ON AN ALREADY-SANITISED HREF and must never replace safeVacancyHref. That function
 * is what refuses javascript:, data: and protocol-relative URLs, so anything that builds the
 * href another way gives that protection up. This only appends to a URL already accepted.
 *
 * THE ID TRAVELS IN THE QUERY STRING rather than being scraped from the page: a third-party
 * job board's DOM is not ours to depend on, and scraping it is how a form gets filled for
 * the wrong application. The URL is the one channel the candidate and the extension share.
 */
export function appendAttemptId(href: string, attemptId: string | undefined): string {
  // "#" is safeVacancyHref's refusal value. Decorating it would turn a refusal into
  // "#?jb_attempt_id=..." - still harmless, but no longer recognisably a refusal.
  if (href === "#" || !attemptId) {
    return href;
  }
  try {
    const url = new URL(href);
    url.searchParams.set("jb_attempt_id", attemptId);
    return url.toString();
  } catch {
    // Unreachable while safeVacancyHref runs first. Returning the bare href is the
    // conservative answer: fill nothing rather than fill against a URL we mangled.
    return href;
  }
}
