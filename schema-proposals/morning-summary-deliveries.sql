-- Draft only. Review and approve before running in Supabase SQL Editor.
-- Records one daily morning-summary claim per Planner user. No existing data is changed.

create table public.morning_summary_deliveries (
  user_id uuid not null references auth.users(id) on delete cascade,
  summary_date date not null,
  status text not null check (status in ('processing', 'sent')),
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  constraint morning_summary_deliveries_pkey primary key (user_id, summary_date),
  constraint morning_summary_deliveries_sent_state_check
    check ((status = 'sent') = (sent_at is not null)),
  constraint morning_summary_deliveries_claim_state_check
    check ((status = 'processing') = (claimed_at is not null))
);

alter table public.morning_summary_deliveries enable row level security;

grant all on table public.morning_summary_deliveries to service_role;
