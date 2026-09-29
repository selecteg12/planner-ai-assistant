-- Draft only. Review and approve before running in Supabase SQL Editor.
-- This script creates a new table and does not alter or delete existing data.
-- "sent" is the completed state for a one-time reminder.
-- "processing" + claimed_at are used by the scheduler for atomic work claiming.

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  text text not null check (length(btrim(text)) > 0),
  remind_at timestamptz not null,
  sent_at timestamptz,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'sent', 'cancelled')),
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint reminders_sent_state_check
    check ((status = 'sent') = (sent_at is not null)),
  constraint reminders_claim_state_check
    check ((status = 'processing') = (claimed_at is not null))
);

create index reminders_due_idx
  on public.reminders (remind_at, created_at)
  where status = 'pending';

create index reminders_claimed_idx
  on public.reminders (claimed_at)
  where status = 'processing';

create index reminders_user_created_idx
  on public.reminders (user_id, created_at desc);

alter table public.reminders enable row level security;

create policy "Users can view own reminders"
  on public.reminders
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create own reminders"
  on public.reminders
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own reminders"
  on public.reminders
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own reminders"
  on public.reminders
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on table public.reminders to authenticated;
grant all on table public.reminders to service_role;
