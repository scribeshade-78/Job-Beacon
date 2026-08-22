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
