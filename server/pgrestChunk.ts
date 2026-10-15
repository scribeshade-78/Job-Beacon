/**
 * Chunking for PostgREST in() filters.
 *
 * WHY THIS EXISTS. PostgREST carries an in() filter as a URL query parameter, so the whole
 * id list has to fit in a URI. That makes an unbounded id array a URI-LENGTH bug, not a slow
 * query: MEASURED against this database, 743 vacancy ids produced a ~28.9 KB query string and
 * the gateway answered {"message":"URI too long"} - a hard failure that no amount of retrying
 * fixes, and one that only appears once a table has grown, which is exactly when it is
 * expensive to find.
 *
 * 100 IDS IS A URL BOUND, NOT A PAGE SIZE. Around 3.9 KB per request, comfortably inside the
 * usual 8 KB proxy default, and 8 requests for a 743-row catalogue. Do not raise it to reduce
 * round trips.
 *
 * ONE DEFINITION ON PURPOSE. Every caller that got this wrong got it wrong independently, so
 * the number and the reason live here rather than being restated per call site.
 */
export const READ_CHUNK_SIZE = 100;

/** Splits values into consecutive chunks. Empty in, empty out, so no request is made. */
export function chunkIds<T>(values: readonly T[], size: number = READ_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }

  return chunks;
}
