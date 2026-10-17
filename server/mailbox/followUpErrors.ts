/**
 * The failure vocabulary of the OUTBOUND half of the follow-up lifecycle.
 *
 * Separate from followUpReview's own not-found/not-owned errors because the dispatcher must not
 * import the module that calls it — a class evaluated through an import cycle can be undefined at
 * the moment it is thrown.
 */

/** The draft was generated before subjects existed, so it cannot be approved for sending yet. */
export class FollowUpDraftMissingSubjectError extends Error {
  constructor(public readonly draftId: string) {
    super("Follow-up draft " + draftId + " has no subject, so it cannot be sent yet.");
    this.name = "FollowUpDraftMissingSubjectError";
  }
}

/** No authorization row, or one that is paused/stopped. */
export class FollowUpNotAuthorizedError extends Error {
  constructor(public readonly status: string | null) {
    super(
      status === null
        ? "This candidate has not authorized automation, so nothing may be sent on their behalf."
        : 'Automation is "' + status + '", so nothing may be sent on their behalf.',
    );
    this.name = "FollowUpNotAuthorizedError";
  }
}

/** No connected mailbox, so there is no address to mint an attributable Reply-To from. */
export class FollowUpMailboxUnavailableError extends Error {
  constructor() {
    super("No connected mailbox with an address, so a reply could not be attributed to this candidate.");
    this.name = "FollowUpMailboxUnavailableError";
  }
}

/** No inbound message on this application, so no address the employer actually wrote from. */
export class FollowUpRecipientUnavailableError extends Error {
  constructor(public readonly applicationAttemptId: string) {
    super(
      "No inbound message on application " +
        applicationAttemptId +
        ", so there is no verified employer address to write to.",
    );
    this.name = "FollowUpRecipientUnavailableError";
  }
}

/** Another caller claimed the draft first, or it is no longer pending. */
export class FollowUpNotClaimableError extends Error {
  constructor(public readonly draftId: string) {
    super("Follow-up draft " + draftId + " was claimed or resolved by another request.");
    this.name = "FollowUpNotClaimableError";
  }
}

/** The provider refused definitively; the draft is back in review and safe to retry. */
export class FollowUpSendRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FollowUpSendRejectedError";
  }
}

/**
 * The provider's answer never arrived. The email may or may not have gone out, so the row stays
 * claimed and the recovery pass asks a human to decide.
 */
export class FollowUpDeliveryUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FollowUpDeliveryUnconfirmedError";
  }
}

/** The environment has no mail provider configured. A deployment state, not a send failure. */
export class OutboundMailNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundMailNotConfiguredError";
  }
}
