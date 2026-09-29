-- Draft only. Do not run until reviewed and approved.
-- Stores Telegram session state and deduplicates Telegram webhook updates.
-- This script creates new tables and does not alter existing Planner data.

create table public.telegram_sessions (
  session_key text primary key
    check (session_key ~ '^-?[0-9]+:-?[0-9]+$'),
  session_data jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index telegram_sessions_expiry_idx
  on public.telegram_sessions (expires_at);

alter table public.telegram_sessions enable row level security;
grant all on table public.telegram_sessions to service_role;

create table public.telegram_webhook_updates (
  update_id bigint primary key,
  status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed')),
  received_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint telegram_webhook_updates_completed_state_check
    check ((status = 'completed') = (completed_at is not null))
);

create index telegram_webhook_updates_received_idx
  on public.telegram_webhook_updates (received_at);

alter table public.telegram_webhook_updates enable row level security;
grant all on table public.telegram_webhook_updates to service_role;
