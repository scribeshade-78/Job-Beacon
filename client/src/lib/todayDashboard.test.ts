import { describe, expect, it } from "vitest";
import type { MailboxMessage, ResponseClassificationEntry } from "./mailboxMessages";
import {
  categoryToSectionKey,
  deadlineUrgency,
  groupMessagesForToday,
  TODAY_SECTIONS,
} from "./todayDashboard";

function classification(overrides: Partial<ResponseClassificationEntry> = {}): ResponseClassificationEntry {
  return {
    id: "rc-1",
    category: "recruiter_followup",
    confidence: 0.8,
    modelVersion: "openai/gpt-4o-mini",
    classifiedAt: "2026-08-20T00:00:00Z",
    extractedCompany: null,
    extractedRole: null,
    extractedJobId: null,
    extractedDeadline: null,
    extractedSalaryText: null,
    ...overrides,
  };
}

function message(overrides: Partial<MailboxMessage> = {}): MailboxMessage {
  return {
    id: "m-1",
    mailboxConnectionId: "conn-1",
    applicationAttemptId: null,
    providerMessageId: "pm-1",
    sender: "recruiter@acme.test",
    subject: "Hello",
    receivedAt: "2026-08-20T00:00:00Z",
    classifications: [classification()],
    interviews: [],
    actionItems: [],
    ...overrides,
  };
}

const NOW = new Date("2026-08-20T12:00:00Z");

describe("categoryToSectionKey", () => {
  it("routes each known category to its section", () => {
    expect(categoryToSectionKey("action_required")).toBe("action_required");
    expect(categoryToSectionKey("interview")).toBe("interviews");
    expect(categoryToSectionKey("offer")).toBe("offers");
    expect(categoryToSectionKey("recruiter_followup")).toBe("updates");
    expect(categoryToSectionKey("application_received")).toBe("updates");
    expect(categoryToSectionKey("other")).toBe("updates");
    expect(categoryToSectionKey("rejection")).toBe("rejections");
  });

  it("routes an unknown category to Updates rather than dropping it", () => {
    expect(categoryToSectionKey("some_future_category")).toBe("updates");
  });
});

describe("deadlineUrgency", () => {
  it("returns null for a missing or unparseable deadline", () => {
    expect(deadlineUrgency(null, NOW)).toBeNull();
    expect(deadlineUrgency("not-a-date", NOW)).toBeNull();
  });

  it("classifies a past calendar day as overdue", () => {
    expect(deadlineUrgency("2026-08-19", NOW)).toBe("overdue");
  });

  it("classifies today and anything within 7 days as soon", () => {
    expect(deadlineUrgency("2026-08-20", NOW)).toBe("soon");
    expect(deadlineUrgency("2026-08-27", NOW)).toBe("soon");
  });

  it("classifies 8+ days out as later", () => {
    expect(deadlineUrgency("2026-08-28", NOW)).toBe("later");
  });
});

describe("groupMessagesForToday", () => {
  it("excludes messages that have no classification", () => {
    const sections = groupMessagesForToday(
      [message({ id: "no-class", classifications: [] }), message({ id: "has-class" })],
      NOW,
    );
    const ids = sections.flatMap((s) => s.items.map((i) => i.messageId));
    expect(ids).toEqual(["has-class"]);
  });

  it("buckets each message into the section for its primary classification's category", () => {
    const sections = groupMessagesForToday(
      [
        message({ id: "ar", classifications: [classification({ category: "action_required" })] }),
        message({ id: "iv", classifications: [classification({ category: "interview" })] }),
        message({ id: "of", classifications: [classification({ category: "offer" })] }),
        message({ id: "up", classifications: [classification({ category: "application_received" })] }),
        message({ id: "rj", classifications: [classification({ category: "rejection" })] }),
      ],
      NOW,
    );

    expect(sections.map((s) => [s.key, s.items.map((i) => i.messageId)])).toEqual([
      ["action_required", ["ar"]],
      ["interviews", ["iv"]],
      ["offers", ["of"]],
      ["updates", ["up"]],
      ["rejections", ["rj"]],
    ]);
  });

  it("returns sections in the fixed TODAY_SECTIONS priority order and omits empty ones", () => {
    const sections = groupMessagesForToday(
      [
        message({ id: "rj", classifications: [classification({ category: "rejection" })] }),
        message({ id: "ar", classifications: [classification({ category: "action_required" })] }),
      ],
      NOW,
    );

    expect(sections.map((s) => s.key)).toEqual(["action_required", "rejections"]);
  });

  it("orders items within a section: deadlines first (soonest asc), then the rest newest-received first", () => {
    const items = [
      message({ id: "no-deadline-old", receivedAt: "2026-08-01T00:00:00Z", classifications: [classification({ category: "interview" })] }),
      message({ id: "deadline-late", classifications: [classification({ category: "interview", extractedDeadline: "2026-09-10" })] }),
      message({ id: "no-deadline-new", receivedAt: "2026-08-19T00:00:00Z", classifications: [classification({ category: "interview" })] }),
      message({ id: "deadline-soon", classifications: [classification({ category: "interview", extractedDeadline: "2026-08-22" })] }),
    ];

    const [interviews] = groupMessagesForToday(items, NOW);

    expect(interviews.items.map((i) => i.messageId)).toEqual([
      "deadline-soon",
      "deadline-late",
      "no-deadline-new",
      "no-deadline-old",
    ]);
  });

  it("passes the extracted entities and computed urgency through to the item", () => {
    const [section] = groupMessagesForToday(
      [
        message({
          id: "m",
          classifications: [
            classification({
              category: "interview",
              extractedCompany: "Acme Corp",
              extractedRole: "Backend Engineer",
              extractedJobId: "REQ-42",
              extractedDeadline: "2026-08-21",
              extractedSalaryText: "18-24 LPA",
            }),
          ],
        }),
      ],
      NOW,
    );

    expect(section.items[0]).toEqual({
      messageId: "m",
      subject: "Hello",
      sender: "recruiter@acme.test",
      receivedAt: "2026-08-20T00:00:00Z",
      category: "interview",
      company: "Acme Corp",
      role: "Backend Engineer",
      jobId: "REQ-42",
      deadline: "2026-08-21",
      deadlineUrgency: "soon",
      salaryText: "18-24 LPA",
    });
  });

  it("returns an empty array when no message is classified", () => {
    expect(groupMessagesForToday([message({ classifications: [] })], NOW)).toEqual([]);
  });

  it("keeps every category from TODAY_SECTIONS routable (guards the config against typos)", () => {
    for (const section of TODAY_SECTIONS) {
      for (const category of section.categories) {
        expect(categoryToSectionKey(category)).toBe(section.key);
      }
    }
  });
});
