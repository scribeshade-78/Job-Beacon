-- OAUTH STATE: ATOMIC REPLAY PROTECTION AND PKCE STORAGE IN ONE TABLE.
--
-- TWO DEFECTS, ONE FIX. createOAuthState generated a nonce and THREW IT AWAY, so the signed state
-- was valid for its whole 10-minute TTL and could be replayed: anyone who captured it (history,
-- Referer, a shared URL) could complete an OAuth connect for that candidate. And PKCE was absent
-- entirely - buildGoogleAuthorizeUrl sent no code_challenge - so an intercepted authorization code
-- could be exchanged by whoever took it.
--
-- WHY A TABLE RATHER THAN A CHECK. Replay protection is enforced by the PRIMARY KEY, not by a read
-- followed by a write: the callback DELETEs its own nonce and a second attempt deletes nothing. Two
-- simultaneous callbacks with the same nonce cannot both win, because the delete that matches the
-- row is the one that proceeds - the same "zero rows is the refusal" shape the application lease
-- uses. And the code_verifier has to live SOMEWHERE between the authorize redirect and the
-- callback; binding it to the nonce means one insert serves both purposes.

create table if not exists public.oauth_state (
  nonce         text primary key,
  candidate_id  uuid not null references public.candidate_profiles (id) on delete cascade,
  code_verifier text not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null
);

comment on table public.oauth_state is
  'Short-lived OAuth handshake state. The primary key IS the replay protection: the callback deletes its own nonce, so a reused one matches zero rows. Holds the PKCE code_verifier between the authorize redirect and the token exchange.';

-- Expired rows are worthless and must not accumulate.
create index if not exists oauth_state_expires_at_idx on public.oauth_state (expires_at);
