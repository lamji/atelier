-- A profile row for every account that existed before 0001_profiles.
--
-- The on_auth_user_created trigger only covers sign-ups after it was
-- installed, and the account page saves with an UPDATE (the grants give
-- `authenticated` no update on `id`, so it cannot upsert). An account
-- without a row would load an empty form and "save" into nothing.

insert into public.profiles (id, full_name)
select id, nullif(trim(raw_user_meta_data ->> 'full_name'), '')
from auth.users
on conflict (id) do nothing;
