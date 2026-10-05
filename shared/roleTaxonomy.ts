/**
 * Static, curated role taxonomy (MP-R1). No normalized taxonomy existed
 * anywhere in this repository before this — candidate_selected_roles.role_name
 * is plain text with no CHECK constraint (see that table's migration), so
 * this taxonomy is a client-side curation layer, not a DB-enforced enum.
 * Selecting a taxonomy entry writes its `title` as role_name.
 */
export const ROLE_CATEGORIES = [
  "Engineering",
  "Data",
  "Product",
  "Design",
  "Marketing",
  "Sales",
  "Operations",
  "Customer/Support",
  // Cross-industry coverage. The catalog is a curated starting set, not a claim
  // of exhaustiveness; uncommon occupations still go through the custom-role
  // path, which stores the candidate's own words.
  "Healthcare",
  "Finance",
  "Education",
] as const;

export type RoleCategory = (typeof ROLE_CATEGORIES)[number];

export interface RoleTaxonomyEntry {
  id: string;
  title: string;
  category: RoleCategory;
  aliases: string[];
  skills: string[];
}

export const ROLE_TAXONOMY: RoleTaxonomyEntry[] = [
  // Engineering
  {
    id: "software-engineer",
    title: "Software Engineer",
    category: "Engineering",
    aliases: ["software developer", "developer", "swe"],
    skills: ["javascript", "python", "java", "git", "algorithms"],
  },
  {
    id: "frontend-engineer",
    title: "Frontend Engineer",
    category: "Engineering",
    aliases: ["front-end developer", "ui engineer", "react developer"],
    skills: ["react", "javascript", "css", "html", "typescript"],
  },
  {
    id: "backend-engineer",
    title: "Backend Engineer",
    category: "Engineering",
    aliases: ["back-end developer", "server-side engineer"],
    skills: ["node.js", "sql", "api design", "databases", "python"],
  },
  {
    id: "fullstack-engineer",
    title: "Full Stack Engineer",
    category: "Engineering",
    aliases: ["full-stack developer"],
    skills: ["react", "node.js", "sql", "javascript", "api design"],
  },
  {
    id: "devops-engineer",
    title: "DevOps Engineer",
    category: "Engineering",
    aliases: ["site reliability engineer", "sre", "infrastructure engineer"],
    skills: ["docker", "kubernetes", "ci/cd", "aws", "terraform"],
  },
  {
    id: "mobile-engineer",
    title: "Mobile Engineer",
    category: "Engineering",
    aliases: ["ios developer", "android developer", "mobile developer"],
    skills: ["swift", "kotlin", "react native", "mobile ui", "xcode"],
  },
  {
    id: "qa-engineer",
    title: "QA Engineer",
    category: "Engineering",
    aliases: ["quality assurance engineer", "test engineer", "sdet"],
    skills: ["testing", "automation", "selenium", "test cases", "qa"],
  },
  {
    id: "engineering-manager",
    title: "Engineering Manager",
    category: "Engineering",
    aliases: ["dev manager", "tech lead manager"],
    skills: ["team leadership", "technical strategy", "people management", "agile", "hiring"],
  },

  // Data
  {
    id: "data-analyst",
    title: "Data Analyst",
    category: "Data",
    aliases: ["business analyst", "reporting analyst"],
    skills: ["sql", "excel", "tableau", "data visualization", "statistics"],
  },
  {
    id: "data-scientist",
    title: "Data Scientist",
    category: "Data",
    aliases: ["ml scientist", "applied scientist"],
    skills: ["python", "machine learning", "statistics", "pandas", "sql"],
  },
  {
    id: "data-engineer",
    title: "Data Engineer",
    category: "Data",
    aliases: ["etl developer", "big data engineer"],
    skills: ["sql", "python", "spark", "etl", "airflow"],
  },
  {
    id: "machine-learning-engineer",
    title: "Machine Learning Engineer",
    category: "Data",
    // "ai engineer" is deliberately NOT an alias here. An AI Engineer builds
    // model-backed systems; an ML Engineer trains and ships models. Treating the
    // two as one string meant a candidate who asked for AI engineering was
    // silently given the ML Engineer role, and their saved role_name said
    // "Machine Learning Engineer" — a substitution they never made.
    aliases: ["ml engineer", "machine learning developer", "mlops engineer"],
    skills: ["python", "machine learning", "tensorflow", "pytorch", "mlops"],
  },
  {
    id: "ai-engineer",
    title: "AI Engineer",
    category: "Data",
    aliases: ["artificial intelligence engineer", "ai developer", "llm engineer", "genai engineer"],
    skills: ["python", "llm", "prompt engineering", "rag", "vector databases", "openai"],
  },

  // Healthcare
  {
    id: "registered-nurse",
    title: "Registered Nurse",
    category: "Healthcare",
    aliases: ["nurse", "rn", "staff nurse", "icu nurse"],
    // Skills only: nothing here encodes a licence, a registration or a
    // qualification, and selecting this role must never be read as evidence of
    // one. Those are candidate facts, confirmed by the candidate, not inferred
    // from a role choice.
    skills: ["patient care", "clinical", "triage", "emr", "medication administration"],
  },

  // Finance
  {
    id: "accountant",
    title: "Accountant",
    category: "Finance",
    aliases: ["accounting", "chartered accountant", "staff accountant", "bookkeeper"],
    skills: ["accounting", "gaap", "reconciliation", "excel", "bookkeeping", "tax"],
  },

  // Education
  {
    id: "teacher",
    title: "Teacher",
    category: "Education",
    aliases: ["educator", "instructor", "classroom teacher", "school teacher"],
    skills: ["curriculum", "lesson planning", "classroom management", "assessment"],
  },

  // Product
  {
    id: "product-manager",
    title: "Product Manager",
    category: "Product",
    aliases: ["pm", "product owner"],
    skills: ["roadmapping", "stakeholder management", "user research", "agile", "prioritization"],
  },
  {
    id: "product-analyst",
    title: "Product Analyst",
    category: "Product",
    aliases: ["product data analyst"],
    skills: ["sql", "analytics", "a/b testing", "product metrics", "excel"],
  },
  {
    id: "technical-product-manager",
    title: "Technical Product Manager",
    category: "Product",
    aliases: ["tpm"],
    skills: ["roadmapping", "api design", "agile", "stakeholder management", "technical specs"],
  },

  // Design
  {
    id: "product-designer",
    title: "Product Designer",
    category: "Design",
    aliases: ["ux designer", "ui/ux designer"],
    skills: ["figma", "user research", "wireframing", "prototyping", "interaction design"],
  },
  {
    id: "ux-researcher",
    title: "UX Researcher",
    category: "Design",
    aliases: ["user researcher"],
    skills: ["user research", "usability testing", "interviews", "surveys", "figma"],
  },
  {
    id: "graphic-designer",
    title: "Graphic Designer",
    category: "Design",
    aliases: ["visual designer", "brand designer"],
    skills: ["adobe photoshop", "adobe illustrator", "branding", "typography", "layout"],
  },

  // Marketing
  {
    id: "marketing-manager",
    title: "Marketing Manager",
    category: "Marketing",
    aliases: ["brand manager"],
    skills: ["campaign management", "seo", "content strategy", "analytics", "branding"],
  },
  {
    id: "content-marketer",
    title: "Content Marketer",
    category: "Marketing",
    aliases: ["content writer", "content strategist"],
    skills: ["content writing", "seo", "copywriting", "content strategy", "editing"],
  },
  {
    id: "growth-marketer",
    title: "Growth Marketer",
    category: "Marketing",
    aliases: ["growth hacker", "performance marketer"],
    skills: ["a/b testing", "seo", "paid ads", "analytics", "funnel optimization"],
  },

  // Sales
  {
    id: "account-executive",
    title: "Account Executive",
    category: "Sales",
    aliases: ["sales executive", "ae"],
    skills: ["negotiation", "crm", "pipeline management", "cold calling", "closing"],
  },
  {
    id: "sales-development-representative",
    title: "Sales Development Representative",
    category: "Sales",
    aliases: ["sdr", "business development representative", "bdr"],
    skills: ["prospecting", "cold outreach", "crm", "lead generation", "sales"],
  },
  {
    id: "account-manager",
    title: "Account Manager",
    category: "Sales",
    aliases: ["client success manager", "key account manager"],
    skills: ["relationship management", "upselling", "crm", "account planning", "negotiation"],
  },

  // Operations
  {
    id: "operations-manager",
    title: "Operations Manager",
    category: "Operations",
    aliases: ["ops manager"],
    skills: ["process improvement", "project management", "logistics", "vendor management", "operations"],
  },
  {
    id: "project-manager",
    title: "Project Manager",
    category: "Operations",
    aliases: ["program manager", "pmp"],
    skills: ["project planning", "agile", "stakeholder management", "risk management", "scheduling"],
  },
  {
    id: "hr-generalist",
    title: "HR Generalist",
    category: "Operations",
    aliases: ["human resources generalist", "people operations"],
    skills: ["recruiting", "onboarding", "employee relations", "hr policy", "payroll"],
  },

  // Customer/Support
  {
    id: "customer-support-representative",
    title: "Customer Support Representative",
    category: "Customer/Support",
    aliases: ["customer service representative", "support agent"],
    skills: ["customer service", "zendesk", "communication", "troubleshooting", "empathy"],
  },
  {
    id: "customer-success-manager",
    title: "Customer Success Manager",
    category: "Customer/Support",
    aliases: ["csm", "client success manager"],
    skills: ["relationship management", "onboarding", "retention", "account management", "communication"],
  },
  {
    id: "technical-support-engineer",
    title: "Technical Support Engineer",
    category: "Customer/Support",
    aliases: ["support engineer", "technical support specialist"],
    skills: ["troubleshooting", "customer service", "technical documentation", "debugging", "sql"],
  },
];

/**
 * Search normalization: lowercase, and every run of non-alphanumeric characters
 * becomes one space. "Front-end" and "front end" then compare equal, and
 * "node.js" tokenizes to "node js" — so the exact-match tier holds however a
 * hyphen or slash was typed.
 */
function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Tokens of one title/alias/skill string, under the same normalization. */
function tokensOf(value: string): string[] {
  const normalized = normalizeSearchText(value);
  return normalized === "" ? [] : normalized.split(" ");
}

/** Edit distance, iterative two-row Levenshtein. Small and dependency-free. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];

    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }

    previous = current;
  }

  return previous[b.length];
}

/**
 * How far a query token may differ from a taxonomy word and still count. One
 * edit for words up to 8 characters covers the ordinary typo shapes
 * ("enginer" -> "engineer", "dat" -> "data"); longer words get two, where the
 * larger surface keeps the false-positive rate down.
 */
function typoBudget(length: number): number {
  return length > 8 ? 2 : 1;
}

/**
 * True when one query token matches one taxonomy word.
 *
 * Exact first, then a shared prefix (so "eng" finds "engineer") for tokens of
 * at least three characters, then a bounded edit distance for real typos.
 * Two-character tokens ("pm", "hr", "ae") match exactly only — at that length
 * almost anything is within one edit of almost anything.
 */
function tokenMatchesWord(token: string, word: string): boolean {
  if (token === word) {
    return true;
  }

  if (token.length < 3 || word.length < 3) {
    return false;
  }

  if (word.startsWith(token) || token.startsWith(word)) {
    return true;
  }

  if (Math.abs(token.length - word.length) > 2) {
    return false;
  }

  return levenshtein(token, word) <= typoBudget(Math.max(token.length, word.length));
}

function tokenHits(token: string, words: readonly string[]): boolean {
  return words.some((word) => tokenMatchesWord(token, word));
}

interface RankedRole {
  entry: RoleTaxonomyEntry;
  exact: boolean;
  titleHits: number;
  aliasHits: number;
  skillHits: number;
  totalHits: number;
  index: number;
}

/**
 * The relevance tier an entry earned. Ordered as the product rule states:
 * exact full-string match, then every token in the title, then every token in
 * the aliases, then partial coverage.
 */
function relevanceTier(role: RankedRole, tokenCount: number): number {
  if (role.exact) return 5;
  if (role.titleHits === tokenCount) return 4;
  if (role.aliasHits === tokenCount) return 3;
  return 2;
}

/**
 * Tokenized, ranked role search.
 *
 * The old rule was one whole-string `includes`, so a multi-word query like
 * "Azure Data Engineer" matched nothing and the panel silently fell back to the
 * same default suggestions. This splits the query into tokens, matches each
 * token against a title, alias or skill word, and ranks by how much of the
 * query an entry accounts for:
 *
 *   1. exact full-string match on the title or an alias
 *   2. every token present in the title
 *   3. every token present in the aliases
 *   4. partial coverage, ranked by tokens matched (title, then alias, then skill)
 *
 * SKILLS ARE THE EXISTING RELATED-TERM SURFACE: "spark" or "airflow" finds Data
 * Engineer without a second, fabricated synonym table. A token that matches
 * nothing anywhere contributes no partial credit, so a query carrying one
 * unknown word ("Azure Data Engineer") still surfaces the entries the known
 * tokens describe. An empty query, or one whose tokens match no word at all,
 * returns [] — the zero-result state is the UI's to render.
 */
export function searchRoles(query: string): RoleTaxonomyEntry[] {
  const normalized = normalizeSearchText(query);

  if (normalized === "") {
    return [];
  }

  const queryTokens = normalized.split(" ");
  const ranked: RankedRole[] = [];

  ROLE_TAXONOMY.forEach((entry, index) => {
    const title = normalizeSearchText(entry.title);
    const aliasTexts = entry.aliases.map(normalizeSearchText);
    const exact = title === normalized || aliasTexts.includes(normalized);

    const titleWords = tokensOf(entry.title);
    const aliasWords = entry.aliases.flatMap(tokensOf);
    const skillWords = entry.skills.flatMap(tokensOf);

    let titleHits = 0;
    let aliasHits = 0;
    let skillHits = 0;
    let totalHits = 0;

    for (const token of queryTokens) {
      const inTitle = tokenHits(token, titleWords);
      const inAlias = tokenHits(token, aliasWords);
      const inSkill = tokenHits(token, skillWords);

      if (inTitle) titleHits += 1;
      if (inAlias) aliasHits += 1;
      if (inSkill) skillHits += 1;
      if (inTitle || inAlias || inSkill) totalHits += 1;
    }

    if (exact || totalHits > 0) {
      ranked.push({ entry, exact, titleHits, aliasHits, skillHits, totalHits, index });
    }
  });

  return ranked
    .sort((a, b) => {
      const tierDiff = relevanceTier(b, queryTokens.length) - relevanceTier(a, queryTokens.length);
      if (tierDiff !== 0) return tierDiff;
      if (b.totalHits !== a.totalHits) return b.totalHits - a.totalHits;
      if (b.titleHits !== a.titleHits) return b.titleHits - a.titleHits;
      if (b.aliasHits !== a.aliasHits) return b.aliasHits - a.aliasHits;
      if (b.skillHits !== a.skillHits) return b.skillHits - a.skillHits;
      return a.index - b.index;
    })
    .map((role) => role.entry);
}

/**
 * Compact form used ONLY to recognise a typed role name as a taxonomy entry.
 *
 * "Frontend Developer" and the alias "front-end developer" differ by a space and
 * a hyphen, and a candidate may type either, so the lookup compares them with
 * every separator removed. This is a lookup key, not a matching rule.
 */
function compactSearchText(value: string): string {
  return normalizeSearchText(value).replace(/ /g, "");
}

/** The taxonomy entry a selected role name refers to, or null for a custom role. */
function taxonomyEntryFor(roleName: string): RoleTaxonomyEntry | null {
  const normalized = normalizeSearchText(roleName);

  if (normalized === "") {
    return null;
  }

  const compact = compactSearchText(roleName);

  return (
    ROLE_TAXONOMY.find(
      (entry) =>
        normalizeSearchText(entry.title) === normalized ||
        entry.aliases.some((alias) => normalizeSearchText(alias) === normalized) ||
        compactSearchText(entry.title) === compact ||
        entry.aliases.some((alias) => compactSearchText(alias) === compact),
    ) ?? null
  );
}

/**
 * Whether one job title is relevant to one selected target role — the feed's
 * strict half of the same tokenized matcher searchRoles uses above.
 *
 * RELEVANT MEANS THE TITLE CARRIES THE ROLE, not merely a word from it. The
 * whole role phrase (or a taxonomy title/alias for it) must be present in the
 * title, so "Data Engineer" keeps "Senior Data Engineer" and "Azure Data
 * Engineer" but drops "Data Analyst": one shared word is not the job. Prefix and
 * typo tolerance come from the same tokenMatchesWord, so "Data Engineering Lead"
 * still matches "engineer".
 *
 * SKILLS ARE THE SAME RELATED-TERM SURFACE, matched EXACTLY rather than by
 * prefix: "spark" keeps a Spark Engineer for Data Engineer, while prefixing
 * would let Backend Engineer's "api design" pull in every Product Designer.
 *
 * An unrecognised role name still works — it is matched as its own phrase, which
 * is exactly what a candidate-entered custom role is.
 */
export function isTitleRelevantToRole(title: string, roleName: string): boolean {
  const titleWords = tokensOf(title);

  if (titleWords.length === 0) {
    return false;
  }

  const entry = taxonomyEntryFor(roleName);
  const phrases = [roleName, ...(entry ? [entry.title, ...entry.aliases] : [])];

  for (const phrase of phrases) {
    const tokens = tokensOf(phrase);

    if (tokens.length > 0 && tokens.every((token) => tokenHits(token, titleWords))) {
      return true;
    }
  }

  if (entry) {
    for (const skill of entry.skills) {
      for (const token of tokensOf(skill)) {
        if (token.length >= 3 && titleWords.includes(token)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * True when the title matches ANY selected role. An empty list matches nothing
 * here; the caller decides that "no roles" means "no filtering".
 */
export function matchesAnyTargetRole(title: string, roleNames: readonly string[]): boolean {
  return roleNames.some((roleName) => isTitleRelevantToRole(title, roleName));
}
