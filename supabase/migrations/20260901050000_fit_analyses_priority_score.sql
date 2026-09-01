-- Opportunity Intelligence Phase 2.3b — the §12.1 weighted priority score
-- promoted from a compute-on-read (2.2 / 2.3a, client-side) to a stored,
-- versioned result on fit_analyses.
--
-- Why it can be stored now when 2.3a explicitly said it could not: the
-- three inputs that change outside the fit worker's trigger set — response
-- stage (25%), company credibility (5%), user preferences (5%) — get
-- re-enqueue hooks in the companion 20260901050010_fit_enqueue_mesh
-- migration. The one input no trigger can ever cover is urgency, which
-- decays daily with no data change at all; that is handled by storing the
-- whole per-factor breakdown and letting the reader recompute just the
-- urgency slice (shared/priorityScore.ts finalizeWithFreshUrgency). No
-- nightly sweep and no cron infrastructure is introduced.
--
-- priority_score is the full 8-factor snapshot scalar and is the SORT KEY.
-- Its urgency slice is only as fresh as the last re-analysis, which is
-- good enough to order by a 5%-weight factor; priority_components is what
-- makes the *displayed* number exactly right on any given day.
--
-- priority_components stores each factor's {weight, value, source} rather
-- than just the scalar, for three reasons: the reader needs the other
-- seven weighted values to re-sum after refreshing urgency; the §12.1
-- "would have scored N" surface needs the breakdown; and storing the
-- weights alongside the values makes an old row reproducible after a
-- weight change instead of silently re-weighted. Readers must check
-- priority_score_version before trusting it (the client falls back to the
-- 2.3a on-read computation on any mismatch).
--
-- All four columns are nullable with no default: rows written before this
-- migration have no score until the fit worker next processes them. There
-- is deliberately no backfill UPDATE here — recomputing an analysis is the
-- worker's job, not a migration's, and the client renders correctly from
-- the fallback path in the meantime.
--
-- No grant or policy change is needed: `grant select on public.fit_analyses
-- to authenticated` (20260831120010) is table-level, so it covers columns
-- added later, and fit_analyses_select_own is a row-level predicate that
-- these columns do not affect. Writes remain service_role-only.
--
-- No index on priority_score: the Opportunities list still sorts in JS over
-- an already-fetched page. The index lands with the candidate_opportunities
-- view + pagination (Phase 2.3c), which is what would actually use it.
alter table public.fit_analyses
  add column priority_score          int   check (priority_score >= 0 and priority_score <= 100),
  add column priority_uncapped_score int   check (priority_uncapped_score >= 0 and priority_uncapped_score <= 100),
  add column priority_components     jsonb,
  add column priority_score_version  text;
