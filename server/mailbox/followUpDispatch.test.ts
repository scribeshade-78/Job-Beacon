import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatchFollowUp, recoverStuckFollowUpSends, UNCONFIRMED_DELIVERY_NOTE } from "./followUpDispatch.js";
import type { MailTransport, OutboundEnvelope } from "./mailTransport.js";
import { MailTransportError } from "./mailTransport.js";
import {
  FollowUpDeliveryUnconfirmedError,
  FollowUpMailboxUnavailableError,
  FollowUpNotAuthorizedError,
  FollowUpNotClaimableError,
  FollowUpRecipientUnavailableError,
  FollowUpSendRejectedError,
} from "./followUpErrors.js";

const SECRET = Buffer.alloc(32, 7);

const DRAFT = {
  draftId: "draft-1",
  candidateId: "cand-1",
  applicationAttemptId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  subject: "Re: Data Engineer application",
  text: "Hello, following up.",
  sendAttempts: 2,
};

interface Update {
  table: string;
  payload: Record<string, unknown>;
}

function makeClient(overrides: {
  authorization?: { status: string; consent_version: string } | null;
  mailbox?: { email_address: string } | null;
  messages?: Array<{ id: string; sender: string | null }>;
  nameFact?: { fact_value: string } | null;
  claimRows?: Array<{ id: string }>;
  stuckRows?: Array<{ id: string }>;
  updateRows?: Array<{ id: string }>;
  updateError?: unknown;
  stuckError?: unknown;
} = {}) {
  const updates: Update[] = [];
  const authorization = overrides.authorization === undefined
    ? { status: "authorized", consent_version: "r1-v1" }
    : overrides.authorization;
  const mailbox = overrides.mailbox === undefined ? { email_address: "jane.doe@gmail.com" } : overrides.mailbox;
  const messages = overrides.messages ?? [{ id: "msg-1", sender: "Recruiting <jobs@acme.com>" }];
  const nameFact = overrides.nameFact === undefined ? { fact_value: "Jane Doe" } : overrides.nameFact;
  const claimRows = overrides.claimRows ?? [{ id: "draft-1" }];
  const updateRows = overrides.updateRows ?? [{ id: "draft-1" }];

  const from = (table: string) => {
    let payload: Record<string, unknown> | null = null;

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      lt: () => builder,
      not: () => builder,
      order: () => builder,
      limit: () => builder,
      update: (next: Record<string, unknown>) => {
        payload = next;
        updates.push({ table, payload: next });
        return builder;
      },
      maybeSingle: async () => {
        if (table === "automation_authorizations") return { data: authorization, error: null };
        if (table === "mailbox_connections") return { data: mailbox, error: null };
        if (table === "extracted_facts") return { data: nameFact, error: null };
        return { data: null, error: null };
      },
      single: async () => ({ data: null, error: null }),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
        let result: unknown;

        if (table === "messages") {
          result = { data: messages, error: null };
        } else if (table === "follow_up_drafts" && payload?.status === "sending") {
          result = { data: overrides.updateError ? null : claimRows, error: overrides.updateError ?? null };
        } else if (table === "follow_up_drafts" && overrides.stuckError) {
          result = { data: null, error: overrides.stuckError };
        } else if (table === "follow_up_drafts" && payload === null) {
          // The recovery scan is a bare select on follow_up_drafts.
          result = { data: overrides.stuckRows ?? [], error: null };
        } else if (table === "follow_up_drafts") {
          result = { data: updateRows, error: null };
        } else {
          result = { data: null, error: null };
        }

        return Promise.resolve(result).then(resolve, reject);
      },
    };

    return builder;
  };

  return { client: { from } as unknown as SupabaseClient, updates };
}

function transportOf(behaviour: (envelope: OutboundEnvelope) => Promise<{ providerMessageId: string }>) {
  const send = vi.fn(behaviour);
  return { transport: { send } as unknown as MailTransport, send };
}

const DEPS = {
  transport: transportOf(async () => ({ providerMessageId: "email-1" })).transport,
  from: { name: null, address: "notifications@jobbeacon.in" },
  replyTokenSecret: SECRET,
  now: () => 1_700_000_000_000,
};

describe("dispatchFollowUp — the claim", () => {
  it("claims then settles, and records the provider id with the evidence", async () => {
    const { client, updates } = makeClient();
    const { transport, send } = transportOf(async () => ({ providerMessageId: "email-1" }));

    const result = await dispatchFollowUp(client, DRAFT, { ...DEPS, transport });

    expect(result.providerMessageId).toBe("email-1");
    expect(result.recipient).toBe("jobs@acme.com");
    expect(send).toHaveBeenCalledTimes(1);

    const claim = updates.find((u) => u.payload.status === "sending");
    expect(claim?.payload).toMatchObject({ status: "sending", send_attempts: 3 });

    const settle = updates.find((u) => u.payload.status === "sent");
    expect(settle?.payload).toMatchObject({
      status: "sent",
      provider_message_id: "email-1",
      recipient_address: "jobs@acme.com",
      recipient_message_id: "msg-1",
      consent_version: "r1-v1",
    });
    expect(settle?.payload.body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(settle?.payload.reply_address).toContain("jane.doe+");
  });

  it("refuses when the draft was claimed by someone else, before calling the provider", async () => {
    const { client } = makeClient({ claimRows: [] });
    const { transport, send } = transportOf(async () => ({ providerMessageId: "email-1" }));

    await expect(dispatchFollowUp(client, DRAFT, { ...DEPS, transport })).rejects.toBeInstanceOf(
      FollowUpNotClaimableError,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("needs authorization before anything else", async () => {
    const { client } = makeClient({ authorization: null });
    const { transport, send } = transportOf(async () => ({ providerMessageId: "email-1" }));

    await expect(dispatchFollowUp(client, DRAFT, { ...DEPS, transport })).rejects.toBeInstanceOf(
      FollowUpNotAuthorizedError,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a paused authorization", async () => {
    const { client } = makeClient({ authorization: { status: "paused", consent_version: "r1-v1" } });

    await expect(dispatchFollowUp(client, DRAFT, DEPS)).rejects.toBeInstanceOf(FollowUpNotAuthorizedError);
  });

  it("refuses without a connected mailbox, because no reply could be attributed", async () => {
    const { client } = makeClient({ mailbox: null });

    await expect(dispatchFollowUp(client, DRAFT, DEPS)).rejects.toBeInstanceOf(FollowUpMailboxUnavailableError);
  });

  it("refuses when no inbound message supplies a verified address", async () => {
    const { client } = makeClient({ messages: [] });

    await expect(dispatchFollowUp(client, DRAFT, DEPS)).rejects.toBeInstanceOf(FollowUpRecipientUnavailableError);
  });

  it("ignores an unparseable sender and uses the next message that names one", async () => {
    const { client } = makeClient({
      messages: [
        { id: "msg-bad", sender: "not an address" },
        { id: "msg-good", sender: "jobs@acme.com" },
      ],
    });
    const { transport, send } = transportOf(async () => ({ providerMessageId: "email-1" }));

    const result = await dispatchFollowUp(client, DRAFT, { ...DEPS, transport });

    expect(result.recipient).toBe("jobs@acme.com");
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("dispatchFollowUp — failure settlement", () => {
  it("hands a DEFINITIVE rejection back to review", async () => {
    const { client, updates } = makeClient();
    const { transport } = transportOf(async () => {
      throw new MailTransportError("422 invalid from", { retryable: false, status: 422 });
    });

    await expect(dispatchFollowUp(client, DRAFT, { ...DEPS, transport })).rejects.toBeInstanceOf(
      FollowUpSendRejectedError,
    );

    const revert = updates.find((u) => u.payload.status === "pending_review");
    expect(revert?.payload).toMatchObject({ status: "pending_review", sending_started_at: null });
    expect(String(revert?.payload.last_send_error)).toContain("422");
  });

  it("keeps an AMBIGUOUS failure claimed, because the email may already be out", async () => {
    const { client, updates } = makeClient();
    const { transport } = transportOf(async () => {
      throw new MailTransportError("socket hang up", { retryable: true, ambiguous: true });
    });

    await expect(dispatchFollowUp(client, DRAFT, { ...DEPS, transport })).rejects.toBeInstanceOf(
      FollowUpDeliveryUnconfirmedError,
    );

    // No SETTLEMENT: the row stays claimed for the sweep (the claim itself is expected).
    expect(updates.filter((u) => u.payload.status === "sent" || u.payload.status === "pending_review")).toHaveLength(0);
    expect(updates.some((u) => typeof u.payload.last_send_error === "string")).toBe(true);
  });
});

describe("recoverStuckFollowUpSends", () => {
  it("returns orphaned claims to review with the note a human needs", async () => {
    const { client, updates } = makeClient({ stuckRows: [{ id: "stuck-1" }] });

    const result = await recoverStuckFollowUpSends(client, { now: () => 1_700_000_000_000 });

    expect(result).toEqual({ scanned: 1, recovered: 1 });

    const revert = updates.find((u) => u.payload.status === "pending_review");
    expect(revert?.payload.last_send_error).toBe(UNCONFIRMED_DELIVERY_NOTE);
    expect(String(revert?.payload.last_send_error)).toContain("24 hours");
  });

  it("counts nothing when a concurrent writer already settled the row", async () => {
    const { client } = makeClient({ stuckRows: [{ id: "stuck-1" }], updateRows: [] });

    expect(await recoverStuckFollowUpSends(client)).toEqual({ scanned: 1, recovered: 0 });
  });
});
