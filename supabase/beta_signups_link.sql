-- Links beta waitlist signups to app accounts (auth.users) by email, and adds
-- an `invited` flag so registration can be gated later.
-- Safe to re-run.

alter table public.beta_signups
  add column if not exists invited            boolean not null default true,
  add column if not exists invited_at         timestamptz,
  add column if not exists registered_user_id uuid references auth.users (id) on delete set null,
  add column if not exists registered_at      timestamptz;

-- Everyone on the list today counts as invited; new rows default to invited too.
update public.beta_signups set invited_at = coalesce(invited_at, created_at) where invited and invited_at is null;
alter table public.beta_signups alter column invited_at set default now();

-- When an account exists with a CONFIRMED email that is on the waitlist, record the link.
-- It must never break sign-up, so any error is swallowed.
create or replace function public.link_beta_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is not null and new.email_confirmed_at is not null then
    update public.beta_signups
       set registered_user_id = new.id,
           registered_at      = coalesce(registered_at, now())
     where email_normalised = lower(new.email)
       and registered_user_id is null;
  end if;
  return new;
exception when others then
  return new;
end;
$$;

revoke all on function public.link_beta_signup() from public, anon, authenticated;

drop trigger if exists link_beta_signup_on_user on auth.users;
create trigger link_beta_signup_on_user
  after insert or update of email_confirmed_at on auth.users
  for each row execute function public.link_beta_signup();

-- Backfill accounts that already exist.
update public.beta_signups b
   set registered_user_id = u.id, registered_at = coalesce(b.registered_at, now())
  from auth.users u
 where lower(u.email) = b.email_normalised
   and u.email_confirmed_at is not null
   and b.registered_user_id is null;

-- One row per account: did they come from the waitlist, and were they invited?
-- Admin-only (service role / SQL editor); not exposed to the app's API roles.
create or replace view public.app_users as
select u.id,
       u.email,
       u.created_at,
       u.email_confirmed_at,
       (b.id is not null)           as from_beta_waitlist,
       coalesce(b.invited, false)   as invited,
       b.created_at                 as waitlisted_at
  from auth.users u
  left join public.beta_signups b on b.email_normalised = lower(u.email);

revoke all on public.app_users from anon, authenticated;
grant select on public.app_users to service_role;
