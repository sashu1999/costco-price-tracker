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

-- ── Added for groups: store picker and per-person email alerts ──────────────
alter table public.profiles add column if not exists warehouse_name text;
alter table public.profiles add column if not exists email_alerts boolean not null default true;

-- Daily in-store price per warehouse, written by the scheduled check. Prices are
-- public information, so any signed-in user may read them.
create table if not exists public.price_history (
  warehouse  text not null,
  item       text not null,
  checked_on date not null,
  price      numeric(10,2) not null,
  primary key (warehouse, item, checked_on)
);
alter table public.price_history enable row level security;
drop policy if exists "signed-in users read prices" on public.price_history;
create policy "signed-in users read prices" on public.price_history
  for select to authenticated using (public.session_verified());

-- Which drops each person was already emailed about, so an alert goes out once per price.
create table if not exists private_alerts_sent (
  user_id uuid not null,
  item    text not null,
  price   numeric(10,2) not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, item, price)
);
alter table private_alerts_sent enable row level security;
revoke all on private_alerts_sent from anon, authenticated;

-- ── Added for claims and reminders ───────────────────────────────────────────
-- When the person got their price adjustment, and how much they got back.
alter table public.items add column if not exists claimed_at timestamptz;
alter table public.items add column if not exists claimed_amount numeric(10,2);

-- "Last chance" reminders already emailed, once per purchase.
create table if not exists private_reminders_sent (
  user_id   uuid not null,
  item      text not null,
  bought_on date not null,
  sent_at   timestamptz not null default now(),
  primary key (user_id, item, bought_on)
);
alter table private_reminders_sent enable row level security;
revoke all on private_reminders_sent from anon, authenticated;
