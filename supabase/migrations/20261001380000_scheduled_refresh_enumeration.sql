-- D1-RANK-SCHEDULE — service-role enumeration for the SCHEDULED ranking refresh.
--
-- WHY THIS EXISTS. The scheduled ranking-refresh task (server/schedulerTasks.ts)
-- runs as service_role and must find candidates whose derived ranking is not
-- current. candidate_ranking_status is a candidate-facing security_invoker view
-- keyed on auth.uid(), so it is deliberately unusable for a service-role sweep:
-- auth.uid() is null there and the view would report nothing. This function is
-- the service-role counterpart: one bounded, deterministic query instead of an
-- N+1 loop over every profile calling candidate_ranking_state individually.
--
-- WHAT IT RETURNS. Candidates who have at least one selected role AND whose
-- candidate_ranking_state is neither 'current' nor 'no_target_roles'. A candidate
-- with no selected roles has nothing to rank and is never returned, so scheduled
-- work cannot sweep the shared posting index on behalf of someone who never
-- expressed a preference.
--
-- FAILED REFRESHES ARE DELIBERATELY EXCLUDED. The manual path treats 'failed' as
-- terminal until an explicit user retry (request(force => true)) re-arms it; the
-- schedule must not auto-retry it, or a poisoned candidate would be retried every
-- interval forever. A refresh with a LIVE lease is excluded too, so a tick cannot
-- pile onto work already in progress.
--
-- IT MATCHES/TOKENISES NOTHING. candidate_ranking_state is the authoritative
-- applicability check already used by the manual route; this function only
-- enumerates the candidates it says are not current.
--
-- SERVICE-ROLE ONLY. No candidate may enumerate other candidates; authenticated
-- and anon have no EXECUTE grant.

create function public.list_candidates_needing_ranking_refresh(p_limit integer default 20)
returns table (candidate_id uuid, reason text)
language sql
stable
security definer
set search_path = public
as $$
  with candidates as (
    select distinct r.candidate_id as id
    from public.candidate_selected_roles r
  ),
  needing as (
    select c.id as id, public.candidate_ranking_state(c.id) as state
    from candidates c
  )
  select n.id as candidate_id, n.state as reason
  from needing n
  left join public.candidate_ranking_refresh f
    on f.candidate_id = n.id
  where n.state <> 'current'
    and n.state <> 'no_target_roles'
    and coalesce(f.status, 'idle') <> 'failed'
    and not (
      coalesce(f.status, 'idle') = 'running'
      and f.leased_until is not null
      and f.leased_until > now()
    )
  order by n.id
  limit greatest(coalesce(p_limit, 20), 0);
$$;

revoke all on function public.list_candidates_needing_ranking_refresh(integer) from public;
revoke all on function public.list_candidates_needing_ranking_refresh(integer) from anon;
revoke all on function public.list_candidates_needing_ranking_refresh(integer) from authenticated;
grant execute on function public.list_candidates_needing_ranking_refresh(integer) to service_role;

comment on function public.list_candidates_needing_ranking_refresh(integer) is
  'Service-role enumeration for the scheduled ranking refresh: candidates with selected roles whose ranking is not current, excluding failed refreshes (explicit-retry only) and live-leased ones, ordered by candidate_id for deterministic bounded paging.';

-- ---------------------------------------------------------------------------
-- VALIDATION QUERIES — none executed here; NOT database tests. The runnable
-- fixture is supabase/tests/database/scheduled_ranking_refresh_enumeration.test.sql
-- and is labelled UNEXECUTED.
--
-- 1. Only candidates with selected roles appear:
--      select count(*) from public.list_candidates_needing_ranking_refresh(20);
--
-- 2. A current candidate is absent; a stale one is present.
-- 3. A failed refresh is absent; a live-leased refresh is absent.
-- 4. authenticated cannot execute:
--      -- as authenticated, select public.list_candidates_needing_ranking_refresh(20);
--      -- expect 42501
--
-- ROLLBACK
--   drop function if exists public.list_candidates_needing_ranking_refresh(integer);
--   Only an enumeration helper is lost; nothing is stored.
-- ---------------------------------------------------------------------------
