import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchFollowUp } from "../mailbox/followUpDispatch.js";
import { FollowUpNotClaimableError } from "../mailbox/followUpErrors.js";
import type { MailTransport } from "../mailbox/mailTransport.js";
import { createTestDatabaseClient } from "./testDatabase.js";

/**
 * TWO CONCURRENT APPROVALS, ONE EMAIL.
 *
 * The unit tests prove the dispatcher's branches against a fake client. This one proves the thing
 * only a real database can: that the claim is a compare-and-swap, so two requests that both load a
 * pending draft cannot both deliver it. The transport is faked ONLY because it is a third party —
 * everything between it and the row (consent, recipient, claim, settlement) is real Postgres.
 *
 *   npm run test:db
 */

const SECRET = Buffer.alloc(32, 9);
const FROM = { name: null, address: "notifications@jobbeacon.in" };

interface Fixture {
  candidateId: string;
  planId: string;
  attemptId: string;
  connectionId: string;
  draftId: string;
}

describe("dispatchFollowUp — the claim against real Postgres", () => {
  let client: SupabaseClient;
  let fixture: Fixture | null;

  beforeEach(() => {
    client = createTestDatabaseClient();
    fixture = null;
  });

  afterEach(async () => {
    if (!fixture) return;

    // Messages reference the attempt without a cascade, so the connection (which cascades them)
    // goes first. The attempt is then deleted EXPLICITLY: application_attempts.application_plan_id
    // has no ON DELETE CASCADE, so deleting the plan first fails and silently leaves the whole
    // chain behind — which is exactly what a first version of this cleanup did.
    await client.from("mailbox_connections").delete().eq("id", fixture.connectionId);
    await client.from("application_attempts").delete().eq("id", fixture.attemptId);
    await client.from("application_plans").delete().eq("id", fixture.planId);
  });

  async function build(): Promise<Fixture> {
    // An existing AUTHORIZED candidate, because service_role has SELECT only on that table and
    // manufacturing consent for a test would be the wrong kind of shortcut.
    const { data: authorizations, error: authorizationError } = await client
      .from("automation_authorizations")
      .select("candidate_id")
      .eq("status", "authorized");

    expect(authorizationError).toBeNull();

    const candidateIds = (authorizations ?? []).map((row) => (row as { candidate_id: string }).candidate_id);
    expect(candidateIds.length).toBeGreaterThan(0);

    const { data: existing } = await client
      .from("mailbox_connections")
      .select("candidate_id")
      .in("candidate_id", candidateIds);

    const taken = new Set((existing ?? []).map((row) => (row as { candidate_id: string }).candidate_id));
    const candidateId = candidateIds.find((id) => !taken.has(id));

    if (!candidateId) {
      throw new Error("Every authorized candidate already has a mailbox connection; refusing to overwrite one.");
    }

    const { data: vacancies, error: vacancyError } = await client.from("vacancies").select("id").limit(1);
    expect(vacancyError).toBeNull();
    const vacancyId = (vacancies?.[0] as { id: string } | undefined)?.id;
    if (!vacancyId) throw new Error("No vacancy in the local database; seed it before running the DB suite.");

    const { data: plan, error: planError } = await client
      .from("application_plans")
      .insert({ candidate_id: candidateId, vacancy_id: vacancyId, gate_results: {} })
      .select("id")
      .single();
    expect(planError).toBeNull();
    const planId = (plan as { id: string }).id;

    const { data: attempt, error: attemptError } = await client
      .from("application_attempts")
      .insert({ application_plan_id: planId })
      .select("id")
      .single();
    expect(attemptError).toBeNull();
    const attemptId = (attempt as { id: string }).id;

    const { data: connection, error: connectionError } = await client
      .from("mailbox_connections")
      .insert({
        candidate_id: candidateId,
        provider: "gmail",
        status: "connected",
        email_address: "jane.doe@gmail.com",
      })
      .select("id")
      .single();
    expect(connectionError).toBeNull();
    const connectionId = (connection as { id: string }).id;

    // The ONLY source a recipient may come from: an employer's own From header.
    const { error: messageError } = await client.from("messages").insert({
      mailbox_connection_id: connectionId,
      provider_message_id: "db-test-" + randomUUID(),
      sender: "Acme Recruiting <jobs@acme.com>",
      subject: "Your application",
      received_at: new Date().toISOString(),
      application_attempt_id: attemptId,
    });
    expect(messageError).toBeNull();

    const { data: draft, error: draftError } = await client
      .from("follow_up_drafts")
      .insert({
        application_attempt_id: attemptId,
        draft_text: "Hello, following up on my application.",
        subject: "Re: Data Engineer application",
        model_version: "test/model",
        prompt_version: "follow-up-v2",
      })
      .select("id")
      .single();
    expect(draftError).toBeNull();

    return { candidateId, planId, attemptId, connectionId, draftId: (draft as { id: string }).id };
  }

  it("delivers exactly one email when two approvals race", async () => {
    fixture = await build();

    let sends = 0;
    const transport: MailTransport = {
      async send() {
        sends += 1;
        // Widen the window between claim and settle: if the CAS were a plain read-then-write,
        // this delay is where the second caller would sneak through.
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { providerMessageId: "email-db-1" };
      },
    };

    const draft = {
      draftId: fixture.draftId,
      candidateId: fixture.candidateId,
      applicationAttemptId: "",
      subject: "Re: Data Engineer application",
      text: "Hello, following up on my application.",
      sendAttempts: 0,
    };

    // The attempt id is not exposed by build(); read it back from the draft.
    const { data: stored } = await client
      .from("follow_up_drafts")
      .select("application_attempt_id")
      .eq("id", fixture.draftId)
      .single();
    draft.applicationAttemptId = (stored as { application_attempt_id: string }).application_attempt_id;

    const results = await Promise.allSettled([
      dispatchFollowUp(client, draft, { transport, from: FROM, replyTokenSecret: SECRET }),
      dispatchFollowUp(client, { ...draft }, { transport, from: FROM, replyTokenSecret: SECRET }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(sends).toBe(1);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(FollowUpNotClaimableError);

    const { data: settled, error } = await client
      .from("follow_up_drafts")
      .select("status, sent_at, provider_message_id, recipient_address, recipient_message_id, reply_address")
      .eq("id", fixture.draftId)
      .single();

    expect(error).toBeNull();
    expect(settled).toMatchObject({
      status: "sent",
      provider_message_id: "email-db-1",
      recipient_address: "jobs@acme.com",
    });
    expect((settled as { sent_at: string | null }).sent_at).not.toBeNull();
    expect((settled as { recipient_message_id: string | null }).recipient_message_id).not.toBeNull();
    expect((settled as { reply_address: string | null }).reply_address).toContain("jane.doe+");
  }, 30_000);
});
