#!/usr/bin/env bash
# Simulates a hosted Supabase project WITHOUT default table privileges for the API roles (anon, authenticated,
# service_role): rebuilds `public` with no default grants, applies every migration, then runs supabase/tests/*.sql
# and supabase/checks/hosted_verification.sql. Every file must PASS, which proves the migrations state their own
# privileges and do not rely on a platform setting. Run `stack.sh start` first; run `stack.sh reset` afterwards to
# go back to the normal local state. See supabase/HOSTED_SETUP.md.
export PGHOST=127.0.0.1 PGPORT=54322 PGUSER=postgres
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
psql -q -v ON_ERROR_STOP=1 -d postgres <<'SQL'
drop schema if exists public cascade; create schema public;
grant usage on schema public to anon, authenticated, service_role;
SQL
psql -q -d postgres -c "truncate auth.users cascade" 2>/dev/null
for f in $(ls supabase/migrations/*.sql | sort); do psql -q -v ON_ERROR_STOP=1 -d postgres -f "$f" >/dev/null || { echo "MIGRATION FAILED $f"; exit 1; }; done
echo "migrations applied (no default grants)"
for f in supabase/tests/*.sql; do
  out=$(psql -q -v ON_ERROR_STOP=1 -d postgres -f "$f" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then echo "PASS $(basename $f)"; else echo "FAIL $(basename $f): $(echo "$out" | grep -m1 ERROR | cut -c1-200)"; fi
done
echo "--- hosted readiness checks"
psql -d postgres -At -F ' | ' -f supabase/checks/hosted_verification.sql | grep -E "FAIL|SUMMARY"
