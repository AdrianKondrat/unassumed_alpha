#!/usr/bin/env bash
# Native local "supabase" stack for this sandbox (no Docker): Postgres16 + GoTrue + PostgREST + gateway + SMTP sink.
# usage: stack.sh setup|start|stop|reset|keys     (CONFIRM=false start  => autoconfirm emails)
# Test-only emulation of `supabase start` for sandboxes without Docker. See README.md in this folder.
S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # this folder; binaries/logs/pids live in $S/.run (gitignored)
REPO="$(cd "$S/../.." && pwd)"
RUN="$S/.run"; mkdir -p "$RUN"
export REPO
PGDATA=/var/lib/pgtest/data
JWT_SECRET="super-secret-jwt-token-with-at-least-32-characters-long"
export PGHOST=127.0.0.1 PGPORT=54322 PGUSER=postgres
CONFIRM=${CONFIRM:-true}   # true => email confirmation required (like config.toml enable_confirmations=true)

jwt() { # role
  node -e '
    const c=require("crypto");const b=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
    const h=b({alg:"HS256",typ:"JWT"});const p=b({iss:"supabase-demo",role:process.argv[1],exp:4102444800});
    console.log(h+"."+p+"."+c.createHmac("sha256",process.argv[2]).update(h+"."+p).digest("base64url"));' "$1" "$JWT_SECRET"
}

killport() { for pid in $(lsof -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u); do kill "$pid" 2>/dev/null; done; }

stop_apps() { killport 9999; killport 3001; killport 54321; killport 54324; killport 54325; sleep 1; }

start() {
  pg_isready -q -h 127.0.0.1 -p 54322 || su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D $PGDATA -o '-p 54322 -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp' -l /var/lib/pgtest/pg.log -w start" >/dev/null
  stop_apps; sleep 1
  (cd "$S"; nohup node edge.mjs > "$RUN/edge.log" 2>&1 &)
  cat > "$RUN/pgrst.conf" <<EOF
db-uri = "postgres://authenticator:postgres@127.0.0.1:54322/postgres"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$JWT_SECRET"
server-host = "127.0.0.1"
server-port = 3001
db-pool = 10
EOF
  (nohup "$RUN/bin/postgrest" "$RUN/pgrst.conf" > "$RUN/postgrest.log" 2>&1 &)
  (
    export GOTRUE_DB_DRIVER=postgres DATABASE_URL="postgres://supabase_auth_admin:postgres@127.0.0.1:54322/postgres"
    export API_EXTERNAL_URL=http://127.0.0.1:54321 GOTRUE_API_HOST=127.0.0.1 GOTRUE_API_PORT=9999
    export GOTRUE_SITE_URL=http://127.0.0.1:4321
    export GOTRUE_URI_ALLOW_LIST="http://127.0.0.1:4321/**,http://localhost:4321/**,http://localhost:4322/**,http://127.0.0.1:4322/**"
    export GOTRUE_JWT_SECRET="$JWT_SECRET" GOTRUE_JWT_EXP=3600 GOTRUE_JWT_AUD=authenticated GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
    export GOTRUE_DISABLE_SIGNUP=false GOTRUE_EXTERNAL_EMAIL_ENABLED=true
    if [ "$CONFIRM" = "true" ]; then export GOTRUE_MAILER_AUTOCONFIRM=false; else export GOTRUE_MAILER_AUTOCONFIRM=true; fi
    export GOTRUE_SMTP_HOST=127.0.0.1 GOTRUE_SMTP_PORT=54325 GOTRUE_SMTP_USER=x GOTRUE_SMTP_PASS=x GOTRUE_SMTP_ADMIN_EMAIL=noreply@example.com
    export GOTRUE_MAILER_URLPATHS_CONFIRMATION=/auth/v1/verify GOTRUE_MAILER_URLPATHS_RECOVERY=/auth/v1/verify GOTRUE_MAILER_URLPATHS_INVITE=/auth/v1/verify GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE=/auth/v1/verify
    export GOTRUE_PASSWORD_MIN_LENGTH=6 GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED=true GOTRUE_RATE_LIMIT_EMAIL_SENT=1000
    export GOTRUE_MAILER_TEMPLATES_CONFIRMATION=http://127.0.0.1:54321/templates/confirmation.html GOTRUE_MAILER_TEMPLATES_RECOVERY=http://127.0.0.1:54321/templates/recovery.html
    export GOTRUE_MAILER_SUBJECTS_CONFIRMATION="Confirm your email address" GOTRUE_MAILER_SUBJECTS_RECOVERY="Reset your password"
    export GOTRUE_MAILER_OTP_EXP=3600 GOTRUE_SMTP_MAX_FREQUENCY=1s GOTRUE_LOG_LEVEL=info
    cd "$S"; nohup "$RUN/bin/gotrue" > "$RUN/gotrue.log" 2>&1 &
  )
  for i in $(seq 1 40); do curl -sf -o /dev/null http://127.0.0.1:54321/auth/v1/health && curl -sf -o /dev/null http://127.0.0.1:3001/ && break; sleep 1; done
  curl -s http://127.0.0.1:54321/auth/v1/health; echo
}

reset() {
  psql -q -v ON_ERROR_STOP=1 -d postgres <<'EOF'
drop schema if exists public cascade; create schema public;
grant usage, create on schema public to postgres; grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
EOF
  psql -q -d postgres -c "truncate auth.users cascade" 2>/dev/null
  for f in $(ls $REPO/supabase/migrations/*.sql 2>/dev/null | sort); do
    echo "apply $(basename "$f")"; psql -q -v ON_ERROR_STOP=1 -d postgres -f "$f" || return 1
  done
  [ -s $REPO/supabase/seed.sql ] && psql -q -v ON_ERROR_STOP=1 -d postgres -f $REPO/supabase/seed.sql
  psql -q -d postgres -c "notify pgrst, 'reload schema'" >/dev/null
  sleep 1
}

setup() {
  set -e
  mkdir -p "$RUN/bin" "$RUN/src"
  [ -x "$RUN/bin/postgrest" ] || { curl -fsSL -o "$RUN/pgrst.tar.xz" https://github.com/PostgREST/postgrest/releases/download/v12.2.3/postgrest-v12.2.3-linux-static-x64.tar.xz && tar -xf "$RUN/pgrst.tar.xz" -C "$RUN/bin"; }
  if [ ! -x "$RUN/bin/gotrue" ]; then
    [ -d "$RUN/src/auth" ] || git clone --depth 1 https://github.com/supabase/auth.git "$RUN/src/auth"
    (cd "$RUN/src/auth" && go build -buildvcs=false -o "$RUN/bin/gotrue" .)
  fi
  if [ ! -d "$PGDATA" ]; then
    mkdir -p "$(dirname "$PGDATA")" && chown postgres "$(dirname "$PGDATA")"
    su postgres -c "/usr/lib/postgresql/16/bin/initdb -D $PGDATA -U postgres --auth=trust -E UTF8" >/dev/null
    su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D $PGDATA -o '-p 54322 -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp' -l /var/lib/pgtest/pg.log -w start" >/dev/null
    psql -v ON_ERROR_STOP=1 -q -d postgres -f "$S/bootstrap.sql"
  fi
  echo "setup done: run '$0 start', then '$0 reset'"
}

case "$1" in
  setup) setup ;;
  start) start ;;
  stop) stop_apps; su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D $PGDATA stop" ;;
  reset) reset ;;
  keys) echo "ANON_KEY=$(jwt anon)"; echo "SERVICE_ROLE_KEY=$(jwt service_role)"; echo "API_URL=http://127.0.0.1:54321" ;;
  *) echo "usage: $0 start|stop|reset|keys" ;;
esac
