-- Draft only. Review and approve before running in Supabase SQL Editor.
-- This script creates a new table and does not alter or delete existing data.

create table public.ideas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(btrim(title)) > 0),
  category text,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create index ideas_user_archived_created_idx
  on public.ideas (user_id, archived, created_at desc);

alter table public.ideas enable row level security;

create policy "Users can view own ideas"
  on public.ideas
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create own ideas"
  on public.ideas
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own ideas"
  on public.ideas
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own ideas"
  on public.ideas
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on table public.ideas to authenticated;
grant all on table public.ideas to service_role;
