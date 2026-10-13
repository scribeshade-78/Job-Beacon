# CLAUDE.md

## Project discipline (applies to every task)

These are the working rules. They are stated directly rather than as a list of skills,
because the skills that used to be named here no longer resolve in the current catalog —
load whichever skill actually matches the task, and follow these rules regardless.

1. **Inspect first.** Read the real file, schema or production state before writing anything.
   Never build on a remembered or assumed shape.
2. **No fabrication.** If a number, endpoint or column cannot be verified, say so and stop.
   Reporting an unknown as a fact is the worst available outcome.
3. **Fail-first tests.** Write the test, watch it fail for the right reason, then implement.
4. **Minimal diffs.** Smallest change that does the job; no speculative abstraction.
5. **Verify before claiming success.** Run the real command and read the real output. Never
   report a check as run when it was not.
6. **Push only when the founder says so**, and never with a red suite. Release is gated on
   `npm test` exiting 0.

## Project-specific facts worth restating

- **Deployment ships the working tree, not a commit.** Keep `git status` clean and be on the
  intended commit before running `deploy/deploy.sh`.
- **A local migration file that is not applied fails deploy preflight (Check A).** Apply it and
  record it in `supabase_migrations.schema_migrations` in the same pass.
- **Verify deploys against `/api/health`**, not the deploy output's tail.
