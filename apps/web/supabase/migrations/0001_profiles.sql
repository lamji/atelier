-- Atelier app profiles: one row per account, owned by that account.
--
-- auth.users is not writable by the application and holds no product fields,
-- so the editable half of a person lives here, keyed by the same id. The
-- table is exposed through PostgREST, which means the policies below are the
-- whole of its access control — there is no server-side check in front of it
-- that could be trusted instead.

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  username    text unique,
  website     text,
  avatar_url  text,
  updated_at  timestamptz not null default now(),

  -- Enforced here as well as in the server action, because the action is not
  -- the only way a row can be written: the same JWT works against PostgREST
  -- directly.
  constraint profiles_full_name_length check (full_name is null or char_length(full_name) <= 80),
  constraint profiles_username_shape check (username is null or username ~ '^[a-z0-9_-]{3,32}$'),
  constraint profiles_website_scheme check (website is null or website ~* '^https?://')
);

comment on table public.profiles is
  'Editable per-account profile. Owner-only under RLS; see policies below.';

-- ── Row-level security ───────────────────────────────────────────────────
-- Default deny: with RLS enabled and no policy matching, every statement
-- returns nothing rather than everything. Each policy below then opens
-- exactly one verb, for exactly the owner.

alter table public.profiles enable row level security;

-- Applies the policies to the table owner too, so a future SECURITY DEFINER
-- function or a superuser-ish role cannot read past them by accident.
alter table public.profiles force row level security;

drop policy if exists "profiles are readable by their owner" on public.profiles;
create policy "profiles are readable by their owner"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "profiles are insertable by their owner" on public.profiles;
create policy "profiles are insertable by their owner"
  on public.profiles for insert
  to authenticated
  with check ((select auth.uid()) = id);

drop policy if exists "profiles are updatable by their owner" on public.profiles;
create policy "profiles are updatable by their owner"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  -- Without this, an owner could pass the USING check and then rewrite `id`,
  -- handing the row to someone else.
  with check ((select auth.uid()) = id);

-- Deliberately no delete policy: an account is deleted through auth.users,
-- and the cascade above takes the profile with it.

-- Least-privilege grants. RLS narrows what a role may touch; it cannot grant
-- what the role was never given, and it cannot take back a blanket grant.
revoke all on public.profiles from anon, authenticated;
grant select, insert, update (full_name, username, website, avatar_url) on public.profiles to authenticated;

-- ── Triggers ─────────────────────────────────────────────────────────────

-- Every new account gets a row, so the profile page never has to invent one.
-- SECURITY DEFINER because the signing-up user does not exist yet when this
-- runs; search_path is pinned so the definer rights cannot be aimed at a
-- shadowed table in a schema the caller controls.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''))
  -- A resent confirmation can fire this twice for the same id.
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- updated_at is maintained by the database rather than by whoever writes the
-- row, so a client cannot backdate it.
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

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();
