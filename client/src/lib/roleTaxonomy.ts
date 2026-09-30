/**
 * The role taxonomy and its tokenized matcher now live in shared/roleTaxonomy.ts.
 *
 * Moved there when the server eligibility gate needed the same matcher the
 * Target Roles search and the feed filter use: tsconfig.server.json includes
 * only ["server", "shared"], so a client module searchRoles/matchesAnyTargetRole
 * could never be imported server-side, and copying it would have been a second,
 * driftable matching rule.
 *
 * This re-export keeps every existing client import ("../lib/roleTaxonomy" /
 * "./roleTaxonomy") working unchanged.
 */
export * from "../../../shared/roleTaxonomy";
