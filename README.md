# Unassumed — website

Production landing page for Unassumed. Static assets served from Cloudflare's
edge, with a single Worker route (`POST /api/waitlist`) that sends waitlist
signups to **office@hailanderstudio.com** through Resend.

No framework, no bundler, no runtime dependencies. `public/` is the site exactly
as it ships.

---

## Before the first deploy — do these five things

1. **Set your domain.** Edit `vars.SITE_ORIGIN` in `wrangler.jsonc` (no trailing
   slash), then run `npm run build`. That one value propagates to every canonical
   URL, Open Graph tag, `sitemap.xml` and `robots.txt` entry.
2. **Verify a sending domain in Resend.** Resend → Domains → Add Domain, then add
   the DKIM, SPF and DMARC records to Cloudflare DNS. `WAITLIST_FROM_EMAIL` must
   be an address on that domain (currently `hailanderstudio.com`). Until the
   domain is verified, every send is rejected.
3. **Add the API key as a secret** — never in a committed file, and this repo is
   public:
   ```bash
   npx wrangler secret put RESEND_API_KEY
   ```
   Create the key at resend.com/api-keys with **Sending access** only.
4. **Apply the database schema:**
   ```bash
   npx wrangler d1 migrations apply unassumed-alpha --remote
   ```
5. **Fill in the privacy notice.** `public/privacy.html` has bracketed
   placeholders for your registered company name, address and the transfer
   mechanism in your Resend and Cloudflare contracts.
6. **Decide the bracketed values on the page.** The price, the beta date and the
   rehearsal count render as deliberate blanks (`[$6.99]`, `Nov 2026`, `[5]`).
   That is a design device, not an oversight — but confirm you want it live.

---

## Commands

```bash
npm install          # once
npx wrangler d1 migrations apply unassumed-alpha --local   # once, for local dev
npm run dev          # wrangler dev — the real Worker, locally
npm run check        # build + typecheck + deploy dry-run. Run before every push.
npm run deploy       # build + typecheck + wrangler deploy
npm run tail         # live production logs
```

Local development needs `.dev.vars` (git-ignored). Copy `.dev.vars.example` and
put a real Resend key in it if you want to send test mail; the file is never
uploaded and never committed.

**Variables set in the dashboard are not authoritative.** `wrangler deploy`
replaces the Worker's plain-text variables with exactly the `vars` block in
`wrangler.jsonc`, so a variable added in the dashboard and not listed there is
removed on the next deploy. Secrets are separate and a deploy never touches them.

---

## How it is put together

```
wrangler.jsonc        Deployment config. SITE_ORIGIN and the other vars live here.
scripts/build.mjs     The whole build: propagates the origin, regenerates _headers.
src/
  index.ts            Routing. /api/waitlist, /api/* → 404, everything else → 404 page.
  waitlist.ts         The endpoint: origin check, rate limit, honeypot, validation.
  email.ts            Resend over fetch. Notification + confirmation templates.
  validate.ts         Email parsing and HTML escaping.
  storage.ts          D1 writes. Degrades rather than throws.
  security.ts         Response headers, origin check, optional Turnstile.
  env.ts              Bindings.
migrations/           D1 schema. Applied with `wrangler d1 migrations apply`.
public/               The site. Edit these files directly.
  _headers            GENERATED — do not edit. Change scripts/build.mjs instead.
```

**Requests never touch the Worker unless they have to.** `run_worker_first` is
not set, so anything matching a file in `public/` is served straight from the
edge — the landing page costs zero Worker invocations.

### The form

Both forms are real HTML forms that `POST` to `/api/waitlist`. `app.js` only
intercepts the submit to avoid a page navigation. **If the script fails to load,
signups still work** — the endpoint accepts `application/x-www-form-urlencoded`
and answers with a 303 to `/thanks`.

Abuse controls, in the order they run:

| Control | Where |
|---|---|
| Same-origin check (`Origin`/`Referer` vs `SITE_ORIGIN`) | `src/security.ts` |
| Per-IP rate limit, 5 per 60s | `ratelimits` binding, `wrangler.jsonc` |
| Honeypot field (`company`) — silently accepted, nothing sent | `src/waitlist.ts` |
| 4 KB body cap | `src/waitlist.ts` |
| Duplicate suppression (unique index) | `migrations/0001_*.sql` |
| Turnstile — **off by default**, enabled by setting the secret | `src/security.ts` |

There is no CORS header anywhere, so nothing can read a response cross-origin.

To turn Turnstile on: add the widget to both forms, add
`https://challenges.cloudflare.com` to `script-src` and `frame-src` in
`scripts/build.mjs`, run `npm run build`, then
`npx wrangler secret put TURNSTILE_SECRET_KEY`.

### Where signups are stored

D1, table `waitlist_signups`. **The row is written before Resend is called**, so
an email outage costs a notification, not a signup. The four outcomes:

| Row written | Email sent | Visitor sees | Why |
|---|---|---|---|
| ✅ | ✅ | success | normal |
| ✅ | ❌ | **success** | the address is safe; failing the visitor over our outage would lose a real signup for nothing |
| — (duplicate) | not attempted | success | already on the list; re-sending on demand would make the form a way to mail-bomb someone |
| ❌ | ❌ | 502 | it landed nowhere, so they must be told |

After any Resend outage, this is the recovery query:

```sql
SELECT email, created_at FROM waitlist_signups WHERE notified_at IS NULL ORDER BY created_at;
```

Deduplication is on a fully lower-cased copy of the address (`email_normalised`,
unique index), while `email` keeps the local part as typed — RFC 5321 makes local
parts case-sensitive. `ON CONFLICT DO NOTHING` does the check in one statement,
so two simultaneous submissions of the same address cannot both win.

The `DB` binding is optional in code. If it is missing, the endpoint degrades to
email-only rather than refusing signups.

Useful queries:

```bash
npx wrangler d1 execute unassumed-alpha --remote --command \
  "SELECT COUNT(*) FROM waitlist_signups"
npx wrangler d1 execute unassumed-alpha --remote --command \
  "SELECT source, COUNT(*) FROM waitlist_signups GROUP BY source"   # which form converts
```

### Security headers

`public/_headers` is regenerated by `npm run build`, including the SHA-256 hash
of the inline JSON-LD block. That hash is what lets the Content-Security-Policy
drop `'unsafe-inline'`. **If you add an inline `<script>` or `<style>` to any
page, run `npm run build` or the browser will silently refuse to run it.**

### Fonts

Self-hosted in `public/fonts/` — latin-subset variable WOFF2, 169 KB total. No
request ever goes to Google, which is both faster and one fewer third party to
declare in the privacy notice. Only the two faces that paint above the fold are
preloaded.

---

## DNS and routing

Once the domain is on Cloudflare, uncomment `routes` in `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "unassumed.com", "custom_domain": true }]
```

Then add a redirect rule in the dashboard so one of `www` / apex is canonical —
that belongs at the DNS layer, not in this code.
