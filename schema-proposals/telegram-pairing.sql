-- Telegram account linking through a short-lived code created from the signed-in Planner app.
-- Review and apply to the Planner Supabase project after checking the duplicate preflight below.
-- This does not change tasks, events, habits, or other Planner records.

do $$
begin
  if exists (
    select 1 from public.telegram_users
    group by telegram_id
    having count(*) > 1
  ) then
    raise exception 'telegram_users has duplicate telegram_id values; resolve them before applying this migration.';
  end if;

  if exists (
    select 1 from public.telegram_users
    group by supabase_user_id
    having count(*) > 1
  ) then
    raise exception 'telegram_users has duplicate supabase_user_id values; resolve them before applying this migration.';
  end if;
end;
$$;

create unique index if not exists telegram_users_telegram_id_pairing_uidx
  on public.telegram_users (telegram_id);

create unique index if not exists telegram_users_supabase_user_pairing_uidx
  on public.telegram_users (supabase_user_id);

grant usage on schema public to service_role;
grant select, insert, update on table public.telegram_users to service_role;
grant select, insert, update, delete
  on table public.tasks, public.events, public.habits, public.habit_completions
  to service_role;

create table if not exists public.telegram_pairing_codes (
  code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  supabase_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint telegram_pairing_codes_expiry_check check (expires_at > created_at)
);

create index if not exists telegram_pairing_codes_user_created_idx
  on public.telegram_pairing_codes (supabase_user_id, created_at desc);

create unique index if not exists telegram_pairing_codes_one_active_per_user_uidx
  on public.telegram_pairing_codes (supabase_user_id)
  where consumed_at is null;

alter table public.telegram_pairing_codes enable row level security;
revoke all on table public.telegram_pairing_codes from public, anon, authenticated, service_role;

create or replace function public.get_telegram_link_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_username text;
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  select tu.telegram_username
    into v_username
    from public.telegram_users as tu
   where tu.supabase_user_id = v_user_id
   limit 1;

  return pg_catalog.jsonb_build_object(
    'linked', found,
    'telegram_username', v_username
  );
end;
$$;

create or replace function public.create_telegram_pairing_code(p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_expires_at timestamptz;
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Invalid pairing code hash';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user_id::text, 0));

  if exists (
    select 1 from public.telegram_users as tu where tu.supabase_user_id = v_user_id
  ) then
    raise exception using errcode = 'P0001', message = 'TELEGRAM_ALREADY_LINKED';
  end if;

  if exists (
    select 1
      from public.telegram_pairing_codes as pc
     where pc.supabase_user_id = v_user_id
       and pc.created_at > v_now - interval '60 seconds'
  ) then
    raise exception using errcode = 'P0001', message = 'PAIRING_CODE_RATE_LIMITED';
  end if;

  update public.telegram_pairing_codes as pc
     set consumed_at = v_now
   where pc.supabase_user_id = v_user_id
     and pc.consumed_at is null;

  delete from public.telegram_pairing_codes as pc
   where pc.supabase_user_id = v_user_id
     and (pc.expires_at < v_now - interval '1 day'
       or pc.consumed_at < v_now - interval '1 day');

  insert into public.telegram_pairing_codes (
    code_hash,
    supabase_user_id,
    created_at,
    expires_at
  ) values (
    p_code_hash,
    v_user_id,
    v_now,
    v_now + interval '10 minutes'
  )
  returning expires_at into v_expires_at;

  return pg_catalog.jsonb_build_object('expires_at', v_expires_at);
end;
$$;

create or replace function public.consume_telegram_pairing_code(
  p_code_hash text,
  p_telegram_id bigint,
  p_telegram_username text,
  p_telegram_first_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_linked_user_id uuid;
  v_linked_telegram_id bigint;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'Service role required';
  end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' or p_telegram_id is null then
    return pg_catalog.jsonb_build_object('status', 'invalid_or_expired');
  end if;

  select pc.supabase_user_id
    into v_user_id
    from public.telegram_pairing_codes as pc
   where pc.code_hash = p_code_hash
     and pc.consumed_at is null
     and pc.expires_at > pg_catalog.clock_timestamp()
   for update;

  if not found then
    return pg_catalog.jsonb_build_object('status', 'invalid_or_expired');
  end if;

  update public.telegram_pairing_codes as pc
     set consumed_at = pg_catalog.clock_timestamp()
   where pc.code_hash = p_code_hash;

  select tu.supabase_user_id
    into v_linked_user_id
    from public.telegram_users as tu
   where tu.telegram_id = p_telegram_id
   for update;

  if found then
    if v_linked_user_id = v_user_id then
      update public.telegram_users as tu
         set telegram_username = p_telegram_username,
             telegram_first_name = p_telegram_first_name
       where tu.telegram_id = p_telegram_id;
      return pg_catalog.jsonb_build_object('status', 'already_linked');
    end if;
    return pg_catalog.jsonb_build_object('status', 'telegram_already_linked');
  end if;

  select tu.telegram_id
    into v_linked_telegram_id
    from public.telegram_users as tu
   where tu.supabase_user_id = v_user_id
   for update;

  if found then
    return pg_catalog.jsonb_build_object('status', 'planner_already_linked');
  end if;

  begin
    insert into public.telegram_users (
      telegram_id,
      supabase_user_id,
      telegram_username,
      telegram_first_name
    ) values (
      p_telegram_id,
      v_user_id,
      p_telegram_username,
      p_telegram_first_name
    );
  exception
    when unique_violation then
      return pg_catalog.jsonb_build_object('status', 'link_conflict');
  end;

  return pg_catalog.jsonb_build_object('status', 'linked');
end;
$$;

revoke all on function public.get_telegram_link_status() from public, anon, service_role;
grant execute on function public.get_telegram_link_status() to authenticated;

revoke all on function public.create_telegram_pairing_code(text) from public, anon, service_role;
grant execute on function public.create_telegram_pairing_code(text) to authenticated;

revoke all on function public.consume_telegram_pairing_code(text, bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.consume_telegram_pairing_code(text, bigint, text, text)
  to service_role;
