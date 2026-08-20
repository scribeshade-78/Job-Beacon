import { describe, expect, it, vi } from "vitest";
import { listMessages } from "./mailboxMessages";

describe("listMessages", () => {
  it("maps message rows with nested classifications, interviews, and action items on success", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [
        {
          id: "message-1",
          mailbox_connection_id: "conn-1",
          application_attempt_id: "attempt-1",
          provider_message_id: "msg-1",
          sender: "recruiter@applyco.example",
          subject: "Re: your application",
          received_at: "2026-08-20T00:00:00Z",
          response_classifications: [
            {
              id: "classification-1",
              category: "interview_invite",
              confidence: 0.92,
              model_version: "classifier-v0",
              classified_at: "2026-08-20T00:01:00Z",
            },
          ],
          interviews: [{ id: "interview-1", scheduled_at: "2026-08-25T10:00:00Z", format: "video" }],
          candidate_action_items: [{ id: "item-1", item_type: "confirm_interview_slot", status: "pending", due_at: "2026-08-22T00:00:00Z" }],
        },
      ],
      error: null,
    });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listMessages>[0];

    const result = await listMessages(client);

    expect(result).toEqual({
      kind: "success",
      messages: [
        {
          id: "message-1",
          mailboxConnectionId: "conn-1",
          applicationAttemptId: "attempt-1",
          providerMessageId: "msg-1",
          sender: "recruiter@applyco.example",
          subject: "Re: your application",
          receivedAt: "2026-08-20T00:00:00Z",
          classifications: [
            {
              id: "classification-1",
              category: "interview_invite",
              confidence: 0.92,
              modelVersion: "classifier-v0",
              classifiedAt: "2026-08-20T00:01:00Z",
            },
          ],
          interviews: [{ id: "interview-1", scheduledAt: "2026-08-25T10:00:00Z", format: "video" }],
          actionItems: [{ id: "item-1", itemType: "confirm_interview_slot", status: "pending", dueAt: "2026-08-22T00:00:00Z" }],
        },
      ],
    });
    expect(from).toHaveBeenCalledWith("messages");
  });

  it("returns empty nested arrays when a message has no classifications, interviews, or action items", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [
        {
          id: "message-2",
          mailbox_connection_id: "conn-1",
          application_attempt_id: null,
          provider_message_id: "msg-2",
          sender: null,
          subject: null,
          received_at: null,
          response_classifications: null,
          interviews: null,
          candidate_action_items: null,
        },
      ],
      error: null,
    });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listMessages>[0];

    const result = await listMessages(client);

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.messages[0].classifications).toEqual([]);
      expect(result.messages[0].interviews).toEqual([]);
      expect(result.messages[0].actionItems).toEqual([]);
    }
  });

  it("returns an empty list when the candidate has no messages", async () => {
    const order = vi.fn().mockResolvedValue({ data: [], error: null });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listMessages>[0];

    const result = await listMessages(client);

    expect(result).toEqual({ kind: "success", messages: [] });
  });

  it("returns a generic error and never the raw message on failure", async () => {
    const order = vi.fn().mockResolvedValue({ data: null, error: { message: "relation does not exist" } });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listMessages>[0];

    const result = await listMessages(client);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("relation");
    }
  });

  it("returns a generic error when the client throws", async () => {
    const from = vi.fn(() => {
      throw new Error("network down");
    });
    const client = { from } as unknown as Parameters<typeof listMessages>[0];

    const result = await listMessages(client);

    expect(result).toEqual({
      kind: "error",
      message: "Could not load your mailbox messages. Please try again.",
    });
  });
});
