create table public.resume_documents (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidate_profiles (id) on delete cascade,
  storage_path text not null unique,
  original_filename text not null,
  mime_type text not null check (
    mime_type in (
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
  ),
  byte_size bigint not null check (byte_size > 0),
  created_at timestamptz not null default now()
);

create index resume_documents_candidate_id_idx on public.resume_documents (candidate_id);

alter table public.resume_documents enable row level security;

-- Same defense-in-depth reasoning as candidate_profiles: revoke everything
-- Supabase's base template pre-grants (TRUNCATE bypasses RLS entirely), then
-- grant back only what this slice needs.
revoke all on public.resume_documents from public;
revoke all on public.resume_documents from anon;
revoke all on public.resume_documents from authenticated;

grant select, insert, delete on public.resume_documents to authenticated;

create policy "resume_documents_select_own"
  on public.resume_documents
  for select
  to authenticated
  using ((select auth.uid()) = candidate_id);

create policy "resume_documents_insert_own"
  on public.resume_documents
  for insert
  to authenticated
  with check ((select auth.uid()) = candidate_id);

create policy "resume_documents_delete_own"
  on public.resume_documents
  for delete
  to authenticated
  using ((select auth.uid()) = candidate_id);

-- Private resume storage (PRD 6, 25.1: "private resume storage and
-- short-lived signed URLs"). Bucket is created here (not only in
-- config.toml) so it exists consistently in every environment, not just
-- local dev.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'resumes',
  'resumes',
  false,
  10485760, -- 10 MiB
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
);

-- Path convention: {candidate_id}/{filename}. storage.foldername(name)
-- splits the object path on "/" and returns the folder segments, so
-- element 1 is the candidate_id folder a client attempted to read/write.
create policy "resume_objects_select_own"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'resumes'
    and (select auth.uid()::text) = (storage.foldername(name))[1]
  );

create policy "resume_objects_insert_own"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'resumes'
    and (select auth.uid()::text) = (storage.foldername(name))[1]
  );

create policy "resume_objects_delete_own"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'resumes'
    and (select auth.uid()::text) = (storage.foldername(name))[1]
  );
