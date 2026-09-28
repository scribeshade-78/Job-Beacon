import { AGENT_QUICK_PROMPTS } from "../../../shared/agent";

/**
 * Which suggested prompts the Copilot offers, given where the candidate is and
 * what the account can actually support.
 *
 * A PURE FUNCTION ON PURPOSE. The interesting behaviour here is conditional —
 * "do not offer resume analysis to someone with no extracted facts" — and
 * keeping it free of Supabase and React is what makes that condition testable in
 * the repository's existing logic-test pattern rather than needing a render
 * harness this codebase does not have.
 *
 * NOTHING HERE IS EVER A PRETENDED ACTION. A suggestion is either a question the
 * Copilot can genuinely answer from the context already injected into its prompt
 * (selected roles, confirmed facts, application plans, fit analyses), or a
 * PREREQUISITE with a link to the page that fixes it. There is deliberately no
 * third kind: no suggestion that looks live but has nothing behind it.
 */

export type CopilotPage = "home" | "resumes" | "opportunities" | "applications" | "responses" | "other";

/**
 * Routes come from client/src/App.tsx. Anything unrecognised is "other" rather
 * than a guess, so a new page gets the general prompts instead of inheriting
 * another page's assumptions.
 */
export function pageForPath(path: string): CopilotPage {
  if (path === "/" || path === "") {
    return "home";
  }

  if (path.startsWith("/resumes")) {
    return "resumes";
  }

  if (path.startsWith("/opportunities")) {
    return "opportunities";
  }

  if (path.startsWith("/applications")) {
    return "applications";
  }

  if (path.startsWith("/responses")) {
    return "responses";
  }

  return "other";
}

export interface CopilotSignals {
  targetRoleCount: number;
  /**
   * Extracted resume facts of ANY confirmation status.
   *
   * Extraction is what this gates — a candidate whose resume has not been
   * extracted has nothing for the Copilot to read. Confirmation is a separate
   * axis the server is stricter about (it only ever injects CONFIRMED facts), and
   * gating on it here would hide a prompt from someone the assistant can still
   * partly help, so it is not part of this signal.
   */
  extractedFactCount: number;
}

export interface CopilotPrerequisite {
  message: string;
  href: string;
  linkLabel: string;
}

export interface CopilotSuggestion {
  /** The pill's text, which is also the question when it is usable. */
  label: string;
  /** The prompt to send. Null when this entry is a prerequisite rather than an action. */
  prompt: string | null;
  /** Present only when prompt is null. */
  prerequisite?: CopilotPrerequisite;
}

const TARGET_ROLES_PREREQUISITE: CopilotPrerequisite = {
  message: "Choose at least one target role first, so the Copilot knows what you are looking for.",
  href: "/target-roles",
  linkLabel: "Choose target roles",
};

const RESUME_PREREQUISITE: CopilotPrerequisite = {
  message:
    "Resume analysis needs extracted details the Copilot can read. Upload your resume and extract it first.",
  href: "/resumes",
  linkLabel: "Go to Resumes",
};

const TOP_MATCHES: CopilotSuggestion = {
  label: "Show my top-matching jobs today",
  prompt: AGENT_QUICK_PROMPTS[0],
};

const FOLLOW_UP: CopilotSuggestion = {
  label: "Draft a follow-up for my pending applications",
  prompt: AGENT_QUICK_PROMPTS[2],
};

const RESUME_ANALYSIS_LABEL = "Analyze my resume gaps for a target role";

function prerequisite(label: string, prerequisite: CopilotPrerequisite): CopilotSuggestion {
  return { label, prompt: null, prerequisite };
}

/**
 * Null means "the account's data could not be read", which is NOT the same as
 * "there is none".
 *
 * The distinction matters: claiming a prerequisite the Copilot cannot prove
 * would tell a candidate with a perfectly good resume to go and upload one. When
 * the signals are unknown the resume-dependent suggestion is OMITTED rather than
 * shown either way — the assistant still answers, and it says itself when it has
 * nothing to work from.
 */
function resumeAnalysis(hasFacts: boolean | null): CopilotSuggestion | null {
  if (hasFacts === null) {
    return null;
  }

  return hasFacts
    ? { label: RESUME_ANALYSIS_LABEL, prompt: AGENT_QUICK_PROMPTS[1] }
    : prerequisite(RESUME_ANALYSIS_LABEL, RESUME_PREREQUISITE);
}

/** Drops the omitted entries and caps the list, because the drawer shows a short column of pills. */
function compact(suggestions: Array<CopilotSuggestion | null>, limit = 3): CopilotSuggestion[] {
  return suggestions.filter((entry): entry is CopilotSuggestion => entry !== null).slice(0, limit);
}

export function suggestCopilotPrompts(
  page: CopilotPage,
  signals: CopilotSignals | null,
): CopilotSuggestion[] {
  const hasRoles = signals === null ? null : signals.targetRoleCount > 0;
  const hasFacts = signals === null ? null : signals.extractedFactCount > 0;

  switch (page) {
    case "home":
      // The setup ladder: roles, then a readable resume, then real questions.
      if (hasRoles === false) {
        return [prerequisite("Choose the roles I'm targeting", TARGET_ROLES_PREREQUISITE)];
      }

      if (hasRoles === true && hasFacts === false) {
        return [prerequisite("Add and extract my resume", RESUME_PREREQUISITE)];
      }

      return compact([TOP_MATCHES, resumeAnalysis(hasFacts), FOLLOW_UP]);

    case "resumes":
      return compact([
        resumeAnalysis(hasFacts),
        {
          label: "What does JobBeacon need from my resume?",
          prompt: "What does JobBeacon need from my resume before it can use it?",
        },
        hasFacts === true
          ? {
              label: "Which details still need confirming?",
              prompt: "Which of my extracted details are still waiting to be confirmed?",
            }
          : null,
      ]);

    case "opportunities":
      if (hasRoles === false) {
        return [prerequisite("Choose the roles I'm targeting", TARGET_ROLES_PREREQUISITE)];
      }

      return compact([
        TOP_MATCHES,
        {
          label: "How can I improve my matches?",
          prompt: "How can I improve the jobs I am being matched with?",
        },
        {
          label: "What is making some matches ineligible?",
          prompt: "What is blocking the jobs I have been matched with?",
        },
      ]);

    case "applications":
      return compact([
        {
          label: "What is waiting on my approval?",
          prompt: "What applications are waiting on my approval?",
        },
        {
          label: "Walk me through my application statuses",
          prompt: "Walk me through the status of my applications.",
        },
        hasFacts === false ? prerequisite(FOLLOW_UP.label, RESUME_PREREQUISITE) : hasFacts === true ? FOLLOW_UP : null,
      ]);

    case "responses":
      return compact([
        {
          label: "Summarise my recruiter replies",
          prompt: "Summarise the recruiter replies I have received.",
        },
        {
          label: "Which replies still need an answer?",
          prompt: "Which of my replies still need an answer from me?",
        },
        {
          label: "Help me draft a reply",
          prompt: "Help me draft a reply to my most recent message.",
        },
      ]);

    default:
      return compact([TOP_MATCHES, resumeAnalysis(hasFacts), FOLLOW_UP]);
  }
}
