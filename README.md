# 10x Astro Starter

![](./public/template.png)

A modern, opinionated starter template for building fast, accessible web applications.

## Tech Stack

- [Astro](https://astro.build/) v7 - Modern web framework with server-first rendering
- [React](https://react.dev/) v19 - UI library for interactive components
- [TypeScript](https://www.typescriptlang.org/) v6 - Type-safe JavaScript
- [Tailwind CSS](https://tailwindcss.com/) v4 - Utility-first CSS framework
- [Supabase](https://supabase.com/) - Authentication and backend-as-a-service
- [Cloudflare Workers](https://workers.cloudflare.com/) - Edge deployment runtime

## Prerequisites

- Node.js v22.14.0 (as specified in `.nvmrc`)
- npm (comes with Node.js)

## Getting Started

1. Clone the repository:

```bash
git clone https://github.com/przeprogramowani/10x-astro-starter.git
cd 10x-astro-starter
```

2. Install dependencies:

```bash
npm install
```

3. Set up Supabase and configure environment variables — see [Supabase Configuration](#supabase-configuration) below.

4. Create a `.dev.vars` file for local Cloudflare dev secrets:

```bash
cp .env.example .dev.vars
```

5. Run the development server:

```bash
npm run dev
```

## Available Scripts

- `npm run dev` - Start development server (Cloudflare workerd runtime)
- `npm run build` - Build for production
- `npm run preview` - Preview production build
- `npm run lint` - Run ESLint with type-checked rules
- `npm run lint:fix` - Auto-fix ESLint issues
- `npm run format` - Run Prettier
- `npm run smoke` - Smoke test the auth flow against a running server (`BASE_URL`, defaults to `http://localhost:4321`)

## Project Structure

```md
.
├── src/
│ ├── layouts/ # Astro layouts
│ ├── pages/ # Astro pages
│ │ └── api/ # API endpoints
│ ├── components/ # UI components (Astro & React)
│ └── assets/ # Static assets
├── public/ # Public assets
├── wrangler.jsonc # Cloudflare Workers config
```

## Supabase Configuration

This project uses [Supabase](https://supabase.com/) for authentication. Environment variables are declared via Astro's `astro:env` schema and are treated as **server-only secrets** — they are never exposed to the client.

### First-time setup (local, no cloud project needed)

Requires [Docker](https://www.docker.com/) and ~7 GB RAM.

1. Create your `.env` file:

```bash
cp .env.example .env
```

2. Initialize the local Supabase project (creates a `supabase/` config folder):

```bash
npx supabase init
```

3. Start the local stack (downloads Docker images on first run):

```bash
npx supabase start
```

4. Copy the credentials printed by the CLI into your `.env` and `.dev.vars`:

```
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_KEY=<anon key from CLI output>
```

5. To stop the stack when done:

```bash
npx supabase stop
```

The local Studio UI is available at `http://localhost:54323`.

No database tables or migrations are required — this project uses Supabase Auth's built-in `auth.users` table only.

### Using a cloud Supabase project instead

If you prefer to use a hosted Supabase project, add these variables to your `.env` and `.dev.vars` files:

| Variable       | Description                                                |
| -------------- | ---------------------------------------------------------- |
| `SUPABASE_URL` | Project URL from Supabase dashboard → Settings → API       |
| `SUPABASE_KEY` | `anon` public key from Supabase dashboard → Settings → API |

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_KEY=<anon-key>
```

### Email verification in local development

Email confirmation is **required** (`enable_confirmations = true` in `supabase/config.toml`). Local emails are caught by the Supabase CLI's mail server (Mailpit), at `http://127.0.0.1:54324`: open it to click the verification or password-reset link. `npm run smoke` reads the same inbox, so it needs the stack started **with** the mail server.

### Auth routes

| Route                                           | Description                                                 |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `/auth/signin`                                  | Email/password sign-in form                                 |
| `/auth/signup`                                  | Email/password sign-up form                                 |
| `/auth/confirm-email`                           | "Check your inbox" page with a resend form                  |
| `/auth/callback`                                | Emailed-link landing: verifies the link, starts the session |
| `/auth/forgot-password`, `/auth/reset-password` | Self-serve password recovery                                |
| `/dashboard`                                    | Signed-in home, shows the founder's workspace               |

Route protection is handled in `src/middleware.ts`. Add paths to the `PROTECTED_ROUTES` array there to require authentication.

## Deployment

This project deploys to [Cloudflare Workers](https://workers.cloudflare.com/).

1. Build the project:

```bash
npm run build
```

2. Deploy with Wrangler:

```bash
npx wrangler deploy
```

Set `SUPABASE_URL` and `SUPABASE_KEY` as secrets in your Cloudflare dashboard or via `npx wrangler secret put`.

## Smoke test

`scripts/smoke.mjs` is a dependency-free Node script that walks the whole auth flow (sign-up, sign-in, protected page, sign-out) over HTTP. Run it against the dev server or the production preview after dependency upgrades:

```bash
npm run dev            # or: npm run build && npm run preview
BASE_URL=http://localhost:4321 npm run smoke
```

It needs a reachable Supabase instance (local or cloud) with email confirmation disabled.

> **Note:** this script exists primarily to guard the development of the starter itself — it is a fast sanity check that dependency upgrades did not break the build, the Cloudflare adapter or the Supabase auth flow. It is **not** a substitute for a real test suite. Once you build your own product on top of this starter, add proper tests (unit, integration, end-to-end) suited to your application.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every push and PR to `master` and `mvp`:

- **ci** — lint, `astro check`, `npm run test:ai` and build. Configure `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `OPENROUTER_API_KEY` as repository secrets for the build step.
- **smoke** — starts a local Supabase via the Supabase CLI, builds, serves the production preview on the Cloudflare runtime and runs `npm run smoke` against it. No secrets required.
- **deploy** — only on a push to `mvp`, and only after `ci` and `smoke` pass. See [MVP deploy](#mvp-deploy).

## MVP deploy

Pushing to the `mvp` branch deploys the app as the Cloudflare Worker **`unassumed-mvp`** (reachable on its `workers.dev` URL). It is a separate Worker from the `unassumed_alpha` main-branch landing page and waitlist, which this pipeline never touches. Pushes to any other branch never deploy.

### One-time setup

1. **Hosted Supabase project** for the MVP. In the dashboard:
   - Authentication → URL Configuration: set _Site URL_ to the deployed Worker URL and add `<worker url>/auth/callback` to _Redirect URLs_.
   - Authentication → Providers → Email: keep _Confirm email_ **on** (verification is required, FR-001) and set the minimum password length to 8.
   - Authentication → Emails → Templates: paste `supabase/templates/confirmation.html` into _Confirm sign up_ and `supabase/templates/recovery.html` into _Reset password_ (subjects: "Confirm your email address" / "Reset your password"). These link straight to `/auth/callback?token_hash=…`, so verification works when the email is opened on a different browser or phone.
   - Authentication → SMTP: configure a real SMTP provider (the built-in mailer is heavily rate-limited and only sends to team members).
2. **GitHub repository secrets** (Settings → Secrets and variables → Actions):

   | Secret                         | Purpose                                                                                                                   |
   | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
   | `CLOUDFLARE_API_TOKEN`         | API token with _Workers Scripts: Edit_ and _Workers KV Storage: Edit_ (the Astro adapter binds a `SESSION` KV namespace). |
   | `CLOUDFLARE_ACCOUNT_ID`        | Your Cloudflare account id.                                                                                               |
   | `SUPABASE_URL`, `SUPABASE_KEY` | Hosted MVP project URL and `anon` key (also set as Worker runtime secrets by the deploy job).                             |

| `SUPABASE_SERVICE_ROLE_KEY` | Hosted project `service_role` key (Settings → API). Server-only: reads the hidden rehearsal persona. Never put it in the browser. |
| `OPENROUTER_API_KEY` | OpenRouter key for all AI calls (also set as a Worker runtime secret). |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD` (opt.) | When all three exist, the deploy job runs `supabase db push` before deploying so the schema never lags the code. |

The deploy job fails fast with the list of any missing required secret.

3. Make sure the `mvp` branch exists on GitHub, then push to it.

### What a deploy does

lint, type check, offline AI checks, build, local-Supabase smoke test → (optional) `supabase db push` → `npm run build` → `wrangler deploy` (config generated by the Astro Cloudflare adapter under `dist/server`) → HTTP 200 check against the deployed URL. Deploys are serialised (`concurrency: deploy-mvp`). Roll back with `npx wrangler rollback` or by re-deploying an earlier commit.

## License

MIT
