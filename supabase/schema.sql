-- Price Adjust Tracker: accounts, per-user items and enforced two-step login.
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run again.
--
-- How the two steps are enforced:
--   1. Password sign-in gives a session whose JWT "amr" says password.
--      The app calls password_checked(), which records that moment.
--   2. The app signs out, emails a 6-digit code, and signs in with it.
--      That OTP session calls verify_session(). It only succeeds if the
--      password was checked for the same user in the last 10 minutes, and
--      it marks this session as fully verified.
--   Item rows are readable and writable only from a verified session, so
--   neither the password alone nor the email code alone opens the data.

create table if not exists public.items (
  user_id    uuid not null references auth.users on delete cascade default auth.uid(),
  item       text not null check (item ~ '^[0-9]{3,9}$'),
  name       text,
  paid       numeric(10,2),
  bought_on  date,
  warehouse  text,
  note       text,
  added_at   timestamptz not null default now(),
  primary key (user_id, item)
);

create table if not exists public.profiles (
  user_id    uuid primary key references auth.users on delete cascade default auth.uid(),
  warehouse  text not null default '233',
  updated_at timestamptz not null default now()
);

-- Step-1 records and verified sessions are only touched by the functions below.
create table if not exists private_password_checks (
  user_id    uuid not null,
  checked_at timestamptz not null default now()
);
create table if not exists private_verified_sessions (
  session_id uuid primary key,
  user_id    uuid not null,
  verified_at timestamptz not null default now()
);
alter table private_password_checks enable row level security;
alter table private_verified_sessions enable row level security;
revoke all on private_password_checks, private_verified_sessions from anon, authenticated;

create or replace function public.session_amr_has(method text) returns boolean
language sql stable as $$
  select exists (
    select 1 from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) a
    where a ->> 'method' = method
  );
$$;

create or replace function public.password_checked() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.session_amr_has('password') then
    raise exception 'Sign in with your password first';
  end if;
  insert into private_password_checks (user_id) values (auth.uid());
end $$;

create or replace function public.verify_session() returns boolean
language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  if auth.uid() is null or not (public.session_amr_has('otp') or public.session_amr_has('magiclink')) then
    raise exception 'Enter the emailed code first';
  end if;
  select exists (
    select 1 from private_password_checks
    where user_id = auth.uid() and checked_at > now() - interval '10 minutes'
  ) into ok;
  if not ok then
    raise exception 'Your password check expired. Start the sign-in again.';
  end if;
  delete from private_password_checks where user_id = auth.uid();
  insert into private_verified_sessions (session_id, user_id)
  values ((auth.jwt() ->> 'session_id')::uuid, auth.uid())
  on conflict (session_id) do nothing;
  return true;
end $$;

create or replace function public.session_verified() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from private_verified_sessions
    where session_id = (auth.jwt() ->> 'session_id')::uuid and user_id = auth.uid()
  );
$$;

revoke all on function public.password_checked(), public.verify_session(), public.session_verified() from public, anon;
grant execute on function public.password_checked(), public.verify_session(), public.session_verified() to authenticated;

alter table public.items enable row level security;
alter table public.profiles enable row level security;

drop policy if exists "own items, verified session" on public.items;
create policy "own items, verified session" on public.items
  for all to authenticated
  using (user_id = auth.uid() and public.session_verified())
  with check (user_id = auth.uid() and public.session_verified());

drop policy if exists "own profile, verified session" on public.profiles;
create policy "own profile, verified session" on public.profiles
  for all to authenticated
  using (user_id = auth.uid() and public.session_verified())
  with check (user_id = auth.uid() and public.session_verified());
