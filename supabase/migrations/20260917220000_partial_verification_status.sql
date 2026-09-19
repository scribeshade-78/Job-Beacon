-- Task Y (part 2): let the scoring layer produce VERIFIED_INCOMPLETE itself,
-- instead of intake writing one status and the scorer writing another.
--
-- THE DIVERGENCE THIS CLOSES. Task W's intake ran scoreVacancy (which recorded
-- UNDER_REVIEW in vacancy_trust_scores and set vacancies.trust_status to match)
-- and then overwrote vacancies.trust_status with VERIFIED_INCOMPLETE. Measured
-- against the LATEST score row, that left exactly six rows disagreeing —
-- everything else in the table already agreed:
--
--   source    vacancies.trust_status   latest score status   count
--   jooble    UNDER_REVIEW            UNDER_REVIEW          125
--   remotive  VERIFIED_INCOMPLETE     UNDER_REVIEW            6   <- divergence
--   usajobs   VERIFIED                VERIFIED               29
--
-- Two tables describing one fact and disagreeing is the failure this codebase
-- refuses everywhere else, and it was mine.
--
-- THE FIX IS IN THE SCORER, NOT IN A SECOND WRITE. scoreVacancy buckets a
-- computed score into VERIFIED (>=80) / UNDER_REVIEW (50-79) / FLAGGED (<50)
-- and has never produced VERIFIED_INCOMPLETE; its own comment records that as
-- deferred to R5. It now produces it for sources that declare they need it,
-- and writes it once — to vacancy_trust_scores.status and vacancies.trust_status
-- in the same pass, as it always has. Intake no longer overrides anything.
--
-- WHY A SOURCE-LEVEL FLAG AND NOT A DERIVED RULE. It could be argued that
-- VERIFIED_INCOMPLETE should follow from the score's own component breakdown
-- (employerIdentity scoring 0 because the source publishes no domain, rather
-- than because of a negative signal). That rule would apply to every source at
-- once and would reclassify Jooble's 125 UNDER_REVIEW rows — which are
-- genuinely unverifiable scraped listings, not merely incomplete ones. A
-- per-source declaration keeps that decision reviewable as data, and defaults
-- to false so no existing source changes behaviour.
alter table public.source_policies
  add column partial_verification_allowed boolean not null default false;

comment on column public.source_policies.partial_verification_allowed is
  'When true, a vacancy from this source that scores into the UNDER_REVIEW bucket is recorded as VERIFIED_INCOMPLETE instead — "legitimate listing, some non-critical fields unconfirmed" rather than "employer identity could not be established". Never upgrades a FLAGGED score and never downgrades a VERIFIED one.';

-- Remotive publishes no company domain, no country and (for most postings) no
-- parseable salary, so employerIdentity scores 0/20 and the 80-point threshold
-- is unreachable — see server/intake/adapters/remotive.ts for why each of those
-- fields is deliberately absent rather than guessed. The listings themselves
-- are real, curated and link back to Remotive, which is what VERIFIED_INCOMPLETE
-- describes. Jooble is left false on purpose: it is a scraper whose postings
-- genuinely cannot be traced to the employer.
update public.source_policies
  set partial_verification_allowed = true
  where source_code = 'remotive';

-- Backfill the six rows the old override left disagreeing, so the two tables
-- agree immediately rather than only after the next scoring pass.
--
-- Scoped tightly: only the LATEST score row per vacancy (75 vacancies in this
-- database have more than one, and rewriting an older row would falsify a
-- historical measurement), only for sources that now declare partial
-- verification, and only where the vacancy itself already says
-- VERIFIED_INCOMPLETE — so this cannot relabel anything the scorer did not
-- already conclude. The numeric score column is untouched: the measurement did
-- not change, only the label derived from it.
update public.vacancy_trust_scores s
  set status = 'VERIFIED_INCOMPLETE'
  from public.vacancies v
  join public.source_policies sp on sp.source_code = v.source_code
  where s.vacancy_id = v.id
    and sp.partial_verification_allowed
    and s.status = 'UNDER_REVIEW'
    and v.trust_status = 'VERIFIED_INCOMPLETE'
    and s.scored_at = (
      select max(s2.scored_at) from public.vacancy_trust_scores s2 where s2.vacancy_id = v.id
    );
