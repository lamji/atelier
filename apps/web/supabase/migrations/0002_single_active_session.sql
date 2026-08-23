-- One active Atelier installation per account.
--
-- The table is both the takeover lock and the Realtime signal used to make
-- the previous installation sign out immediately. Supabase Auth session
-- revocation is handled by the client with signOut({ scope: 'others' }) after
-- the user explicitly confirms the takeover.

create table if not exists public.active_sessions (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  device_id     uuid not null,
  device_label  text not null,
  updated_at    timestamptz not null default now(),

  constraint active_sessions_device_label_length
    check (char_length(device_label) between 1 and 120)
);

comment on table public.active_sessions is
  'The single Atelier installation currently allowed to use an account.';

alter table public.active_sessions enable row level security;
alter table public.active_sessions force row level security;

drop policy if exists "active session is readable by its owner"
  on public.active_sessions;
create policy "active session is readable by its owner"
  on public.active_sessions for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "active session is insertable by its owner"
  on public.active_sessions;
create policy "active session is insertable by its owner"
  on public.active_sessions for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "active session is updatable by its owner"
  on public.active_sessions;
create policy "active session is updatable by its owner"
  on public.active_sessions for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "active session is removable by its owner"
  on public.active_sessions;
create policy "active session is removable by its owner"
  on public.active_sessions for delete
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.active_sessions from anon, authenticated;
grant select, insert, update, delete
  on public.active_sessions
  to authenticated;

-- Keep this migration runnable on projects where the profiles migration was
-- not applied first (for example, when this file is pasted into the SQL editor).
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists active_sessions_touch_updated_at
  on public.active_sessions;
create trigger active_sessions_touch_updated_at
  before update on public.active_sessions
  for each row execute function public.touch_updated_at();

-- Realtime UPDATE payloads must contain the complete replacement row so the
-- displaced installation can compare the new device_id with its own.
alter table public.active_sessions replica identity full;

-- Local Supabase projects may already publish every table. Add this one only
-- when it is not already part of the Realtime publication.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'active_sessions'
  ) then
    alter publication supabase_realtime add table public.active_sessions;
  end if;
end;
$$;
