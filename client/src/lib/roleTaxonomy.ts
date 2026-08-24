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
    aliases: ["ml engineer", "ai engineer"],
    skills: ["python", "machine learning", "tensorflow", "pytorch", "mlops"],
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

/** Case-insensitive substring match against title and aliases. Empty query returns no results. */
export function searchRoles(query: string): RoleTaxonomyEntry[] {
  const normalized = query.trim().toLowerCase();

  if (normalized === "") {
    return [];
  }

  return ROLE_TAXONOMY.filter(
    (entry) =>
      entry.title.toLowerCase().includes(normalized) ||
      entry.aliases.some((alias) => alias.toLowerCase().includes(normalized)),
  );
}
