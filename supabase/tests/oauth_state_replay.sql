begin;
select plan(3);

create temporary table t_state as
  select 'nonce-' || gen_random_uuid()::text as nonce, (select id from candidate_profiles limit 1) as cid;

insert into oauth_state (nonce, candidate_id, code_verifier, expires_at)
select nonce, cid, 'verifier-abc', now() + interval '10 minutes' from t_state;

select is(
  (select count(*)::int from oauth_state where nonce = (select nonce from t_state)),
  1,
  'the authorize step persists the nonce and its PKCE verifier'
);

with consumed as (
  delete from oauth_state where nonce = (select nonce from t_state) returning code_verifier
)
select is(
  (select code_verifier from consumed),
  'verifier-abc',
  'the callback atomically consumes the nonce and gets the verifier back'
);

with replay as (
  delete from oauth_state where nonce = (select nonce from t_state) returning 1
)
select is(
  (select count(*)::int from replay),
  0,
  'A REPLAYED NONCE DELETES NOTHING - the second callback cannot win'
);

-- THE PRIMARY KEY IS THE SECOND LINE, not the first: a duplicate nonce is refused outright
-- while the first is outstanding. What carries replay protection is the ZERO-ROW DELETE above,
-- because that is what a replayed callback actually does.

select * from finish();
rollback;
