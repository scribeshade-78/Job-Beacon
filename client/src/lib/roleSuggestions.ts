import type { ExtractedFact } from "./resumeExtraction";
import { ROLE_TAXONOMY, type RoleCategory, type RoleTaxonomyEntry } from "./roleTaxonomy";

export type SuggestionTier = "primary" | "strong" | "related";

export interface RoleSuggestion {
  entry: RoleTaxonomyEntry;
  tier: SuggestionTier;
}

function effectiveValue(fact: ExtractedFact): string {
  return (fact.correctedValue ?? fact.factValue).trim();
}

function titleMatchesEntry(confirmedTitle: string, entry: RoleTaxonomyEntry): boolean {
  const normalizedTitle = confirmedTitle.toLowerCase();

  if (normalizedTitle === "") {
    return false;
  }

  return [entry.title, ...entry.aliases].some((candidate) => {
    const normalizedCandidate = candidate.toLowerCase();
    return normalizedTitle.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedTitle);
  });
}

/**
 * Tiered role suggestions from the candidate's *confirmed* facts only
 * (MP-F2's confirmation gate — a pending or rejected fact is not a
 * reliable signal). Effective value is correctedValue ?? factValue, same
 * "what the candidate actually confirmed" rule resumeGenerator.ts uses.
 *
 * Primary: confirmed current_title substring-matches a taxonomy title/alias.
 * Strong: same category as a Primary match, >=2 shared confirmed skills.
 * Related: same category with 1 shared skill, or a different category with
 * >=2 shared skills — this branch also fires with no Primary match at all
 * (a candidate who confirmed skills but no title still gets skill-only
 * suggestions; there's no "Primary category" to compare against, so every
 * category is treated as "different").
 *
 * Stretch tier (e.g. a seniority-based reach beyond Related) is deferred —
 * no approved signal source (years_of_experience heuristic vs per-entry
 * seniority tag) yet.
 */
export function suggestRoles(facts: ExtractedFact[]): RoleSuggestion[] {
  const confirmed = facts.filter((fact) => fact.confirmationStatus === "confirmed");

  const confirmedTitles = confirmed.filter((fact) => fact.factType === "current_title").map(effectiveValue);
  const confirmedSkills = new Set(
    confirmed.filter((fact) => fact.factType === "skill").map((fact) => effectiveValue(fact).toLowerCase()),
  );

  const primaryEntries = ROLE_TAXONOMY.filter((entry) =>
    confirmedTitles.some((title) => titleMatchesEntry(title, entry)),
  );
  const primaryIds = new Set(primaryEntries.map((entry) => entry.id));
  const primaryCategories = new Set<RoleCategory>(primaryEntries.map((entry) => entry.category));

  const suggestions: RoleSuggestion[] = primaryEntries.map((entry) => ({ entry, tier: "primary" }));

  for (const entry of ROLE_TAXONOMY) {
    if (primaryIds.has(entry.id)) {
      continue;
    }

    const sharedSkillCount = entry.skills.filter((skill) => confirmedSkills.has(skill.toLowerCase())).length;
    const sameCategoryAsPrimary = primaryCategories.has(entry.category);

    if (sameCategoryAsPrimary && sharedSkillCount >= 2) {
      suggestions.push({ entry, tier: "strong" });
    } else if ((sameCategoryAsPrimary && sharedSkillCount === 1) || (!sameCategoryAsPrimary && sharedSkillCount >= 2)) {
      suggestions.push({ entry, tier: "related" });
    }
  }

  return suggestions;
}
