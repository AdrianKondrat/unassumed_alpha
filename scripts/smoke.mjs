// Smoke test: proves the built app, the Cloudflare adapter and the Supabase auth flow still work together,
// including email verification and password reset by following the links actually emailed.
// Zero dependencies on purpose. Run against a live server with a local Supabase (email confirmations on):
//   BASE_URL=http://localhost:4321 MAIL_URL=http://127.0.0.1:54324 node scripts/smoke.mjs
//
// Product-flow steps (project, canvas draft, ...) also need the fake OpenRouter (scripts/fake-openrouter.mjs)
// running, with the app started using OPENROUTER_BASE_URL pointing at it. Set FAKE_AI_URL to its origin
// (e.g. http://127.0.0.1:4010) to include them; without it they are skipped.
//
// Optional: set SUPABASE_URL and SUPABASE_ANON_KEY to also prove, through the real PostgREST with the founder's
// own session token, that the hidden rehearsal persona cannot be read or written by a client.

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4321";
const MAIL_URL = process.env.MAIL_URL ?? "http://127.0.0.1:54324";
const FAKE_AI_URL = process.env.FAKE_AI_URL ?? "";
const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const email = `smoke-${Date.now()}@example.com`;
const password = "Smoke-Test-Passw0rd!";
const newPassword = "Smoke-Test-New-Passw0rd!";
const jar = new Map();
const usedMail = new Set();
let verifyLink = "";
let resetLink = "";

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function storeCookies(response) {
  for (const raw of response.headers.getSetCookie()) {
    const [pair, ...attrs] = raw.split(";");
    const [name, ...rest] = pair.split("=");
    const expired = attrs.some((a) => /max-age=0/i.test(a.trim()));
    if (expired) jar.delete(name.trim());
    else jar.set(name.trim(), rest.join("="));
  }
}

async function request(path, { method = "GET", form } = {}) {
  const response = await fetch(BASE_URL + path, {
    method,
    redirect: "manual",
    headers: {
      Cookie: cookieHeader(),
      Origin: BASE_URL,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  storeCookies(response);
  const text = method === "GET" && response.status === 200 ? await response.text() : "";
  return { status: response.status, location: response.headers.get("location") ?? "", text };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Newest unseen message to `to` whose subject matches, via Mailpit (current CLI) or Inbucket (older CLI). */
async function fetchMail(to, subjectPattern) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const found = await findMail(to, subjectPattern);
    if (found) return found;
    await sleep(500);
  }
  throw new Error(`no "${subjectPattern}" email for ${to} at ${MAIL_URL}`);
}

async function findMail(to, subjectPattern) {
  let list = await fetch(`${MAIL_URL}/api/v1/messages`).catch(() => null);
  if (list?.ok) {
    const { messages = [] } = await list.json();
    const hit = messages.find(
      (m) =>
        !usedMail.has(m.ID) &&
        m.To?.some((t) => t.Address?.toLowerCase() === to) &&
        subjectPattern.test(m.Subject ?? ""),
    );
    if (!hit) return null;
    usedMail.add(hit.ID);
    const message = await (await fetch(`${MAIL_URL}/api/v1/message/${hit.ID}`)).json();
    return `${message.HTML ?? ""}\n${message.Text ?? ""}`;
  }
  // Inbucket: GET /api/v1/mailbox/<local-part>
  list = await fetch(`${MAIL_URL}/api/v1/mailbox/${to.split("@")[0]}`).catch(() => null);
  if (!list?.ok) return null;
  const messages = (await list.json()).reverse();
  const hit = messages.find((m) => !usedMail.has(m.id) && subjectPattern.test(m.subject ?? ""));
  if (!hit) return null;
  usedMail.add(hit.id);
  const message = await (await fetch(`${MAIL_URL}/api/v1/mailbox/${to.split("@")[0]}/${hit.id}`)).json();
  return `${message.body?.html ?? ""}\n${message.body?.text ?? ""}`;
}

function extractLink(body) {
  // The email templates link straight to the app's /auth/callback; Supabase's default links go via /auth/v1/verify.
  const match = /https?:\/\/[^\s"'<>]*\/auth\/(?:callback|v1\/verify)[^\s"'<>]*/.exec(body);
  if (!match) throw new Error("no verification link in email");
  return match[0].replaceAll("&amp;", "&");
}

/** Follow an emailed link and hand the resulting app redirect to our app with the cookie jar. */
async function followEmailedLink(link) {
  let url = new URL(link);
  if (url.pathname.startsWith("/auth/v1/verify")) {
    const hop = await fetch(link, { redirect: "manual" });
    const target = hop.headers.get("location");
    if (!target) throw new Error(`verify link did not redirect (status ${hop.status})`);
    url = new URL(target, link);
  }
  if (url.pathname !== "/auth/callback") {
    throw new Error(`link led to ${url.pathname}${url.search.slice(0, 80)}, expected /auth/callback`);
  }
  return request(url.pathname + url.search);
}

const post = (path, form) => () => request(path, { method: "POST", form });

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const countOf = (text, needle) => text.split(needle).length - 1;

async function fake(path) {
  const response = await fetch(FAKE_AI_URL + path, { method: path === "/__reset" ? "POST" : "GET" });
  return response.json();
}
const aiCalls = () => fake("/__calls");

const BRIEF = "A subscription box for left-handed gardeners, sold online with a monthly plan.";
const BLOCK_LABELS = [
  "Customer segments",
  "Value propositions",
  "Channels",
  "Customer relationships",
  "Revenue streams",
  "Key resources",
  "Key activities",
  "Key partners",
  "Cost structure",
];
let callsBefore = 0;
let pendingIds = [];
const reviewPath = (id) => `/api/assumptions/${id}/review`;
const statusPath = (id) => `/api/assumptions/${id}/status`;
const idsOn = (html, kind) => [
  ...new Set([...html.matchAll(new RegExp(`/api/assumptions/([0-9a-f-]{36})/${kind}`, "g"))].map((m) => m[1])),
];
const suggest = () => request("/api/assumptions/suggest", { method: "POST" });
const lastCalls = async (n) => (await aiCalls()).slice(-n);

// ---- Rehearsal helpers (S-05) -----------------------------------------------------------------------
// Planted by scripts/fake-openrouter.mjs in every generated persona scenario. It must never show up in any
// page or API response the founder can see: `corpus` collects every body these steps fetch.
const SCENARIO_MARKER = "SCENARIO-MARKER-9c1e";
const corpus = [];
const note = (text) => {
  corpus.push(text);
  return text;
};
async function api(path, { json, body, contentType = "application/json" } = {}) {
  const response = await fetch(BASE_URL + path, {
    method: "POST",
    redirect: "manual",
    headers: { Cookie: cookieHeader(), Origin: BASE_URL, "Content-Type": contentType },
    body: body ?? JSON.stringify(json ?? {}),
  });
  storeCookies(response);
  const text = note(await response.text());
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON: leave data null
  }
  return { status: response.status, data, text };
}
/** A GET page with React's `<!-- -->` text separators removed so text assertions read naturally. */
async function pageOf(path) {
  const result = await request(path);
  note(result.text);
  return { ...result, text: result.text.replaceAll("<!-- -->", "") };
}
const sessionApi = (id, action) => `/api/rehearsal/sessions/${id}/${action}`;
const ask = (id, question) => api(sessionApi(id, "turns"), { json: { question } });
const startRehearsal = (assumptionId) => request("/api/rehearsal/sessions", { method: "POST", form: { assumptionId } });
const sessionIdFrom = (location) => /^\/rehearsal\/([0-9a-f-]{36})$/.exec(location)?.[1] ?? "";
const switchJar = (saved) => {
  jar.clear();
  for (const [name, value] of saved) jar.set(name, value);
};
const NIL_ID = "11111111-1111-1111-1111-111111111111";
let rehearsable = [];
let sessionOne = "";
let sessionTwo = "";
let zeroSession = "";
let sessionThree = "";
/** Page text with entities decoded and runs of whitespace collapsed, so assertions ignore markup wrapping and escaping. */
const flat = (text) =>
  text
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");
const emailB = `smoke-b-${Date.now()}@example.com`;

/** The founder's Supabase access token, read from the auth cookie (chunked and base64url-encoded by @supabase/ssr). */
function accessTokenFromJar() {
  const chunks = [...jar.entries()]
    .filter(([name]) => /^sb-.*-auth-token(\.\d+)?$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, value]) => decodeURIComponent(value));
  const joined = chunks.join("").replace(/^base64-/, "");
  return JSON.parse(Buffer.from(joined, "base64url").toString("utf8")).access_token;
}

const steps = [
  ["home renders", () => request("/"), { status: 200 }],
  ["dashboard redirects anonymous user", () => request("/dashboard"), { status: 302, location: "/auth/signin" }],
  ["project page redirects anonymous user", () => request("/project"), { status: 302, location: "/auth/signin" }],
  [
    "creating a project anonymously is refused",
    post("/api/projects", { brief: BRIEF }),
    { status: 302, location: "/auth/signin" },
  ],
  ["drafting anonymously is refused", post("/api/projects/draft"), { status: 302, location: "/auth/signin" }],
  [
    "assumptions page redirects anonymous user",
    () => request("/assumptions"),
    { status: 302, location: "/auth/signin" },
  ],
  ["suggesting anonymously is refused", post("/api/assumptions/suggest"), { status: 302, location: "/auth/signin" }],
  [
    "reviewing anonymously is refused",
    post("/api/assumptions/11111111-1111-1111-1111-111111111111/review", { action: "accept" }),
    { status: 302, location: "/auth/signin" },
  ],
  [
    "changing status anonymously is refused",
    post("/api/assumptions/11111111-1111-1111-1111-111111111111/status", { status: "retired" }),
    { status: 302, location: "/auth/signin" },
  ],
  ["rehearsal page redirects anonymous user", () => request("/rehearsal"), { status: 302, location: "/auth/signin" }],
  [
    "rehearsal session page redirects anonymous user",
    () => request(`/rehearsal/${NIL_ID}`),
    { status: 302, location: "/auth/signin" },
  ],
  [
    "scorecard page redirects anonymous user",
    () => request(`/rehearsal/${NIL_ID}/scorecard`),
    { status: 302, location: "/auth/signin" },
  ],
  [
    "starting a rehearsal anonymously is refused",
    post("/api/rehearsal/sessions", { assumptionId: NIL_ID }),
    { status: 302, location: "/auth/signin" },
  ],
  [
    "rehearsal JSON routes answer 401 to anonymous callers",
    async () => {
      for (const action of ["turns", "retry", "end", "score"]) {
        const r = await api(sessionApi(NIL_ID, action), { json: { question: "hello" } });
        check(r.status === 401, `${action}: expected 401, saw ${r.status}`);
      }
      return { status: 200, location: "" };
    },
    { status: 200 },
  ],
  [
    "reset-password page redirects anonymous user",
    () => request("/auth/reset-password"),
    { status: 302, location: "/auth/signin" },
  ],
  [
    "signup rejects a short password",
    post("/api/auth/signup", { email, password: "short" }),
    { status: 302, location: "/auth/signup?error=" },
  ],
  [
    "signup rejects mismatched confirmation",
    post("/api/auth/signup", { email, password, confirmPassword: password + "x" }),
    { status: 302, location: "/auth/signup?error=" },
  ],
  [
    "signup creates account and asks to verify",
    post("/api/auth/signup", { email, password, confirmPassword: password }),
    { status: 302, location: "/auth/confirm-email" },
  ],
  [
    "signin is blocked until the email is verified",
    post("/api/auth/signin", { email, password }),
    { status: 302, location: "/auth/confirm-email?unverified=1" },
  ],
  ["dashboard still closed while unverified", () => request("/dashboard"), { status: 302, location: "/auth/signin" }],
  [
    "resend shows the generic confirmation",
    post("/api/auth/resend", { email }),
    { status: 302, location: "/auth/confirm-email?sent=1" },
  ],
  [
    "resend for an unknown address looks identical",
    post("/api/auth/resend", { email: `nobody-${Date.now()}@example.com` }),
    { status: 302, location: "/auth/confirm-email?sent=1" },
  ],
  [
    "callback with a bad code fails safely",
    () => request("/auth/callback?code=bogus&next=https://evil.example"),
    { status: 302, location: "/auth/signin?error=" },
  ],
  [
    "emailed verification link signs the founder in",
    async () => {
      verifyLink = extractLink(await fetchMail(email, /confirm/i));
      return followEmailedLink(verifyLink);
    },
    { status: 302, location: "/dashboard" },
  ],
  [
    "dashboard shows the founder's own workspace",
    async () => {
      const result = await request("/dashboard");
      if (!result.text.includes("Personal workspace")) result.status = 599;
      if (!result.text.includes(email)) result.status = 598;
      return result;
    },
    { status: 200 },
  ],
  [
    "reusing the verification link fails with a friendly message",
    async () => {
      const response = await request("/api/auth/signout", { method: "POST" });
      if (response.status !== 302) return response;
      return followEmailedLink(verifyLink);
    },
    { status: 302, location: "/auth/signin?error=" },
  ],
  ["dashboard redirects after signout", () => request("/dashboard"), { status: 302, location: "/auth/signin" }],
  [
    "signin rejects wrong password",
    post("/api/auth/signin", { email, password: "wrong-password" }),
    { status: 302, location: "/auth/signin?error=" },
  ],
  [
    "signin accepts correct password",
    post("/api/auth/signin", { email, password }),
    { status: 302, location: "/dashboard" },
  ],
  ["signout clears session", post("/api/auth/signout"), { status: 302, location: "/" }],
  [
    "forgot-password for an unknown address looks identical",
    post("/api/auth/forgot-password", { email: `ghost-${Date.now()}@example.com` }),
    { status: 302, location: "/auth/forgot-password?sent=1" },
  ],
  [
    "forgot-password for the real account shows the same message",
    post("/api/auth/forgot-password", { email }),
    { status: 302, location: "/auth/forgot-password?sent=1" },
  ],
  [
    "emailed reset link opens the new-password page",
    async () => {
      resetLink = extractLink(await fetchMail(email, /reset|recover/i));
      return followEmailedLink(resetLink);
    },
    { status: 302, location: "/auth/reset-password" },
  ],
  ["new-password page renders for the recovery session", () => request("/auth/reset-password"), { status: 200 }],
  [
    "reset rejects a weak password",
    post("/api/auth/reset-password", { password: "short", confirmPassword: "short" }),
    { status: 302, location: "/auth/reset-password?error=" },
  ],
  [
    "reset sets the new password",
    post("/api/auth/reset-password", { password: newPassword, confirmPassword: newPassword }),
    { status: 302, location: "/dashboard?passwordChanged=1" },
  ],
  ["signout after reset", post("/api/auth/signout"), { status: 302, location: "/" }],
  [
    "old password no longer works",
    post("/api/auth/signin", { email, password }),
    { status: 302, location: "/auth/signin?error=" },
  ],
  [
    "new password works",
    post("/api/auth/signin", { email, password: newPassword }),
    { status: 302, location: "/dashboard" },
  ],
  ["dashboard renders for signed-in user", () => request("/dashboard"), { status: 200 }],
  ...(FAKE_AI_URL
    ? [
        [
          "fake OpenRouter is reachable and reset",
          async () => ({ status: (await fake("/__reset")).mode === "ok" ? 200 : 500, location: "" }),
          { status: 200 },
        ],
        [
          "without a project, /project sends the founder to /project/new",
          () => request("/project"),
          { status: 302, location: "/project/new" },
        ],
        [
          "new-project page renders with the brief form",
          async () => {
            const r = await request("/project/new");
            check(r.text.includes('name="brief"') && r.text.includes("Save my notes"), "form missing");
            return r;
          },
          { status: 200 },
        ],
        [
          "a too-short brief is rejected with a message",
          post("/api/projects", { brief: "too short" }),
          { status: 302, location: "/project/new?error=" },
        ],
        [
          "dashboard offers to create the project",
          async () => {
            const r = await request("/dashboard");
            check(r.text.includes("Create your project"), "create CTA missing");
            return r;
          },
          { status: 200 },
        ],
        [
          "a valid brief (CRLF newlines) creates the project",
          post("/api/projects", { brief: BRIEF + "\r\nSecond line." }),
          { status: 302, location: "/project" },
        ],
        [
          "a second project is refused politely, not as an error",
          post("/api/projects", { brief: BRIEF + " Another one." }),
          { status: 302, location: "/project" },
        ],
        [
          "/project/new now redirects to the existing project",
          () => request("/project/new"),
          { status: 302, location: "/project" },
        ],
        [
          "canvas page keeps the brief and offers to draft",
          async () => {
            const r = await request("/project");
            check(
              r.text.includes("Draft my canvas") && r.text.includes("left-handed gardeners"),
              "draft prompt or brief missing",
            );
            check(!r.text.includes('class="tag tag-yellow"'), "claims shown before drafting");
            return r;
          },
          { status: 200 },
        ],
        [
          "dashboard now offers to open the canvas",
          async () => {
            const r = await request("/dashboard");
            check(r.text.includes("Open your canvas") && !r.text.includes("Create your project"), "open CTA missing");
            return r;
          },
          { status: 200 },
        ],
        [
          "provider failure (500) keeps the brief and shows Retry",
          async () => {
            await fake("/__mode?set=http500");
            const r = await request("/api/projects/draft", { method: "POST" });
            check(r.location === "/project?draftError=ai_failed", `redirected to ${r.location}`);
            const page = await request(r.location);
            check(
              page.text.includes("Your notes are safe") && page.text.includes("Try again"),
              "retry message missing",
            );
            check(page.text.includes("left-handed gardeners"), "brief lost");
            return { status: page.status, location: "" };
          },
          { status: 200 },
        ],
        [
          "unparseable model output is rejected, nothing saved",
          async () => {
            await fake("/__mode?set=garbage");
            const r = await request("/api/projects/draft", { method: "POST" });
            check(r.location === "/project?draftError=invalid_output", `redirected to ${r.location}`);
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "a draft claiming ideas are 'validated' is rejected",
          async () => {
            await fake("/__mode?set=viability");
            const r = await request("/api/projects/draft", { method: "POST" });
            check(r.location === "/project?draftError=invalid_output", `redirected to ${r.location}`);
            const page = await request("/project");
            check(!/validated/i.test(page.text.replace(/unvalidated/gi, "")), "forbidden wording reached the page");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "an unknown draftError code is never echoed",
          async () => {
            const r = await request("/project?draftError=%3Cscript%3Ealert(1)%3C/script%3E");
            check(!r.text.includes("<script>alert"), "query string echoed");
            return r;
          },
          { status: 200 },
        ],
        [
          "two parallel draft requests cost exactly one AI call",
          async () => {
            callsBefore = (await aiCalls()).length;
            await fetch(`${FAKE_AI_URL}/__mode?set=slow&ms=1500`);
            const [a, b] = await Promise.all([
              request("/api/projects/draft", { method: "POST" }),
              request("/api/projects/draft", { method: "POST" }),
            ]);
            check(a.status === 302 && b.status === 302, "unexpected status");
            const used = (await aiCalls()).length - callsBefore;
            check(used === 1, `expected 1 AI call, saw ${used}`);
            await fake("/__mode?set=ok");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "canvas shows 9 blocks with 18 claims, every one marked AI draft",
          async () => {
            const r = await request("/project");
            for (const label of BLOCK_LABELS) check(r.text.includes(label), `block missing: ${label}`);
            check(countOf(r.text, 'class="tag tag-yellow"') >= 18, "fewer than 18 AI draft tags");
            check(r.text.includes("first draft to argue with"), "honesty note missing");
            check(!r.text.includes("Draft my canvas"), "draft action still offered");
            check(!r.text.includes('class="tag tag-teal"'), "founder tag on an AI-only canvas");
            return r;
          },
          { status: 200 },
        ],
        [
          "a second draft is a no-op and spends nothing",
          async () => {
            callsBefore = (await aiCalls()).length;
            const r = await request("/api/projects/draft", { method: "POST" });
            check(r.location === "/project", `redirected to ${r.location}`);
            check((await aiCalls()).length === callsBefore, "AI was called again");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "assumptions page asks for a canvas-backed suggestion",
          async () => {
            const r = await request("/assumptions");
            check(
              r.text.includes("Suggest assumptions") && !r.text.includes("To review"),
              "suggest prompt missing or cards present",
            );
            return r;
          },
          { status: 200 },
        ],
        [
          "dashboard links the assumption stage once the canvas exists",
          async () => {
            const r = await request("/dashboard");
            check(r.text.includes("Open your assumptions"), "assumption link missing");
            return r;
          },
          { status: 200 },
        ],
        [
          "suggest: provider failure keeps things safe and offers Retry",
          async () => {
            await fake("/__mode?set=http500");
            const r = await suggest();
            check(r.location === "/assumptions?suggestError=ai_failed", `redirected to ${r.location}`);
            const page = await request(r.location);
            check(page.text.includes("Nothing was lost") && page.text.includes("Try again"), "retry message missing");
            return { status: page.status, location: "" };
          },
          { status: 200 },
        ],
        [
          "suggest: bad output is rejected (garbage, unknown claim, too few, viability wording)",
          async () => {
            for (const mode of ["garbage", "unknown_claim", "short", "viability"]) {
              await fake(`/__mode?set=${mode}`);
              const r = await suggest();
              check(r.location === "/assumptions?suggestError=invalid_output", `${mode}: redirected to ${r.location}`);
            }
            const page = await request("/assumptions");
            check(!page.text.includes("To review"), "a rejected batch left pending cards");
            check(!/proven/i.test(page.text), "forbidden wording reached the page");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "suggest: two parallel requests cost exactly one AI call",
          async () => {
            callsBefore = (await aiCalls()).length;
            await fetch(`${FAKE_AI_URL}/__mode?set=slow&ms=1500`);
            const [a, b] = await Promise.all([suggest(), suggest()]);
            check(a.status === 302 && b.status === 302, "unexpected status");
            const used = (await aiCalls()).length - callsBefore;
            check(used === 1, `expected 1 AI call, saw ${used}`);
            await fake("/__mode?set=ok");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "a batch of 6 pending suggestions appears with sources and the suggest action hides",
          async () => {
            const r = await request("/assumptions");
            pendingIds = idsOn(r.text, "review");
            check(pendingIds.length === 6, `expected 6 cards, saw ${pendingIds.length}`);
            check(
              r.text.includes("To review (6)") && r.text.includes("Keep it") && r.text.includes("Comes from"),
              "card content missing",
            );
            check(!r.text.includes("/api/assumptions/suggest"), "suggest form still offered");
            check(r.text.includes("not findings"), "honesty note missing");
            return r;
          },
          { status: 200 },
        ],
        [
          "suggesting again while pending is a quiet no-op that spends nothing",
          async () => {
            callsBefore = (await aiCalls()).length;
            const r = await suggest();
            check(r.location === "/assumptions", `redirected to ${r.location}`);
            check((await aiCalls()).length === callsBefore, "AI was called with a pending batch");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "accept as written keeps the wording and is not marked edited",
          async () => {
            const r = await request(reviewPath(pendingIds[0]), {
              method: "POST",
              form: {
                action: "accept",
                statement: "Batch 1 assumption 1: customers behave this way",
                riskNote: "Batch 1 risk 1: this could be wrong",
              },
            });
            check(r.location === "/assumptions", `redirected to ${r.location}`);
            const page = await request("/assumptions");
            check(
              page.text.includes("Batch 1 assumption 1") && idsOn(page.text, "status").includes(pendingIds[0]),
              "not in the durable list",
            );
            check(!page.text.includes("Edited by you"), "marked edited without an edit");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "edit-then-accept stores the founder's wording and marks it edited",
          async () => {
            const r = await request(reviewPath(pendingIds[1]), {
              method: "POST",
              form: { action: "accept", statement: "Gardeners will pay 9 pounds a month", riskNote: "" },
            });
            check(r.location === "/assumptions", `redirected to ${r.location}`);
            const page = await request("/assumptions");
            check(
              page.text.includes("Gardeners will pay 9 pounds a month") && page.text.includes("Edited by you"),
              "edit not shown",
            );
            check(!page.text.includes("Batch 1 assumption 2"), "original wording still shown");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "reject removes the suggestion from view",
          async () => {
            const r = await request(reviewPath(pendingIds[2]), { method: "POST", form: { action: "reject" } });
            check(r.location === "/assumptions", `redirected to ${r.location}`);
            const page = await request("/assumptions");
            check(
              !page.text.includes("Batch 1 assumption 3") && !idsOn(page.text, "review").includes(pendingIds[2]),
              "rejected item still listed",
            );
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "reviewing the same suggestion twice gives a friendly message",
          async () => {
            const r = await request(reviewPath(pendingIds[0]), { method: "POST", form: { action: "reject" } });
            check(r.location === "/assumptions?reviewError=not_pending", `redirected to ${r.location}`);
            const page = await request(r.location);
            check(page.text.includes("already been reviewed"), "friendly message missing");
            check(page.text.includes("Batch 1 assumption 1"), "an accepted assumption was lost by the replay");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "a rejected suggestion cannot be reopened",
          async () => {
            const r = await request(reviewPath(pendingIds[2]), { method: "POST", form: { action: "accept" } });
            check(r.location === "/assumptions?reviewError=not_pending", `redirected to ${r.location}`);
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "an empty or over-long edited statement is refused",
          async () => {
            const blank = await request(reviewPath(pendingIds[3]), {
              method: "POST",
              form: { action: "accept", statement: "   " },
            });
            check(blank.location === "/assumptions?reviewError=invalid", `blank: ${blank.location}`);
            const long = await request(reviewPath(pendingIds[3]), {
              method: "POST",
              form: { action: "accept", statement: "x".repeat(281) },
            });
            check(long.location === "/assumptions?reviewError=invalid", `long: ${long.location}`);
            const page = await request("/assumptions");
            check(idsOn(page.text, "review").includes(pendingIds[3]), "invalid edit consumed the suggestion");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "a malformed or unknown assumption id is handled",
          async () => {
            const bad = await request(reviewPath("not-a-uuid"), { method: "POST", form: { action: "accept" } });
            check(bad.location === "/assumptions?reviewError=not_pending", `bad id: ${bad.location}`);
            const ghost = await request(reviewPath("22222222-2222-2222-2222-222222222222"), {
              method: "POST",
              form: { action: "accept" },
            });
            check(ghost.location === "/assumptions?reviewError=not_pending", `ghost: ${ghost.location}`);
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "lifecycle: active -> superseded -> retired -> active, labelled in text",
          async () => {
            for (const status of ["superseded", "retired", "active"]) {
              const r = await request(statusPath(pendingIds[0]), { method: "POST", form: { status } });
              check(r.location === "/assumptions", `${status}: redirected to ${r.location}`);
              const page = await request("/assumptions");
              const label = status[0].toUpperCase() + status.slice(1);
              check(new RegExp(`Status: </span>${label}`).test(page.text), `${status}: label not shown`);
            }
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "lifecycle cannot touch pending or rejected rows, or use bad values",
          async () => {
            const pending = await request(statusPath(pendingIds[3]), { method: "POST", form: { status: "retired" } });
            check(pending.location === "/assumptions?statusError=not_durable", `pending: ${pending.location}`);
            const rejected = await request(statusPath(pendingIds[2]), { method: "POST", form: { status: "active" } });
            check(rejected.location === "/assumptions?statusError=not_durable", `rejected: ${rejected.location}`);
            const bad = await request(statusPath(pendingIds[0]), { method: "POST", form: { status: "validated" } });
            check(bad.location === "/assumptions?statusError=invalid", `bad value: ${bad.location}`);
            const page = await request("/assumptions");
            check(idsOn(page.text, "review").includes(pendingIds[3]), "pending row was moved");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "unknown error codes are never echoed",
          async () => {
            const r = await request(
              "/assumptions?suggestError=%3Cscript%3Ealert(1)%3C/script%3E&reviewError=%3Cb%3Ex&statusError=%3Cb%3Ey",
            );
            check(
              !r.text.includes("<script>alert") && !r.text.includes("<b>x") && !r.text.includes("<b>y"),
              "query string echoed",
            );
            return r;
          },
          { status: 200 },
        ],
        [
          "suggest more is offered only once every pending item is resolved, and learns from rejections",
          async () => {
            let page = await request("/assumptions");
            check(!page.text.includes("/api/assumptions/suggest"), "suggest offered with pending cards");
            for (const id of pendingIds.slice(3)) {
              const r = await request(reviewPath(id), {
                method: "POST",
                form: { action: id === pendingIds[3] ? "accept" : "reject" },
              });
              check(r.location === "/assumptions", `resolve ${id}: ${r.location}`);
            }
            page = await request("/assumptions");
            check(page.text.includes("Suggest more") && !page.text.includes("To review"), "suggest more missing");
            callsBefore = (await aiCalls()).length;
            const r = await suggest();
            check(r.location === "/assumptions", `redirected to ${r.location}`);
            const [call] = await lastCalls(1);
            check((await aiCalls()).length === callsBefore + 1 && call.task === "suggest", "no new suggest call");
            check(
              call.rejectedCount >= 3,
              `prompt carried ${call.rejectedCount} rejected statements, expected at least 3`,
            );
            page = await request("/assumptions");
            check(
              page.text.includes("Batch 2 assumption 1") && page.text.includes("Batch 1 assumption 1"),
              "second batch or earlier assumptions missing",
            );
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "rehearsal page lists the kept assumptions, explains the practice customer, and shows no scenario",
          async () => {
            const r = await pageOf("/rehearsal");
            rehearsable = [...r.text.matchAll(/name="assumptionId" value="([0-9a-f-]{36})"/g)].map((m) => m[1]);
            check(rehearsable.length === 3, `expected 3 rehearsable assumptions, saw ${rehearsable.length}`);
            check(r.text.includes("Choose an assumption (3)") && r.text.includes("Start rehearsal"), "list missing");
            check(r.text.includes("made-up customer") && r.text.includes("not evidence"), "framing missing");
            check(!r.text.includes("Session in progress"), "an active session already exists");
            return r;
          },
          { status: 200 },
        ],
        [
          "starting on a pending or unknown assumption is refused without spending",
          async () => {
            const pending = idsOn((await request("/assumptions")).text, "review");
            check(pending.length > 0, "no pending suggestion to test with");
            callsBefore = (await aiCalls()).length;
            const a = await startRehearsal(pending[0]);
            check(a.location === "/rehearsal?startError=assumption_inactive", `pending: ${a.location}`);
            const b = await startRehearsal("22222222-2222-2222-2222-222222222222");
            check(b.location === "/rehearsal?startError=assumption_not_found", `unknown: ${b.location}`);
            const c = await startRehearsal("not-a-uuid");
            check(c.location === "/rehearsal?startError=assumption_not_found", `malformed: ${c.location}`);
            check((await aiCalls()).length === callsBefore, "an AI call was spent on a refused start");
            const page = await pageOf(a.location);
            check(page.text.includes("keeping active"), "friendly message missing");
            const echo = await pageOf("/rehearsal?startError=%3Cscript%3Ealert(1)%3C/script%3E");
            check(!echo.text.includes("<script>alert"), "query string echoed");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "starting: provider failure and bad scenarios leave no session behind",
          async () => {
            for (const [mode, code] of [
              ["http500", "ai_failed"],
              ["garbage", "invalid_output"],
              ["viability", "invalid_output"],
              ["short", "invalid_output"],
            ]) {
              await fake(`/__mode?set=${mode}`);
              const r = await startRehearsal(rehearsable[0]);
              check(r.location === `/rehearsal?startError=${code}`, `${mode}: redirected to ${r.location}`);
            }
            await fake("/__mode?set=ok");
            const page = await pageOf("/rehearsal");
            check(!page.text.includes("Session in progress"), "a failed start left a session");
            check(page.text.includes("Choose an assumption (3)"), "assumptions disappeared after failed starts");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "starting twice in parallel yields one session",
          async () => {
            await fake("/__mode?set=slow&ms=1200");
            const [a, b] = await Promise.all([startRehearsal(rehearsable[0]), startRehearsal(rehearsable[0])]);
            await fake("/__mode?set=ok");
            sessionOne = sessionIdFrom(a.location);
            check(sessionOne !== "" && a.location === b.location, `redirects differ: ${a.location} vs ${b.location}`);
            const list = await pageOf("/rehearsal");
            check(
              list.text.includes("Session in progress") && list.text.includes(`/rehearsal/${sessionOne}`),
              "no continue link",
            );
            check(!list.text.includes("Choose an assumption"), "start offered while a session is active");
            const again = await startRehearsal(rehearsable[1]);
            check(again.location === `/rehearsal/${sessionOne}`, `a second start went to ${again.location}`);
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "the session page renders the chat with no scenario in its source or props",
          async () => {
            const r = await pageOf(`/rehearsal/${sessionOne}`);
            check(r.text.includes("Questions used: 0 of 8"), "turn counter missing");
            check(
              r.text.includes("Your practice customer is ready") && r.text.includes('id="question"'),
              "chat missing",
            );
            check(r.text.includes("This customer is made up"), "framing missing");
            check(r.text.includes("Ctrl or Cmd"), "send hint missing");
            check(
              !r.text.includes(SCENARIO_MARKER) && !/hidden_truths|current_behaviour/.test(r.text),
              "scenario leaked",
            );
            return r;
          },
          { status: 200 },
        ],
        [
          "a question gets an in-character reply; only seq, question and reply are returned",
          async () => {
            const r = await ask(sessionOne, "What did you do the last time you needed a trowel?");
            check(r.status === 200, `status ${r.status}`);
            check(Object.keys(r.data).sort().join() === "ended,turn", `body keys: ${Object.keys(r.data)}`);
            check(Object.keys(r.data.turn).sort().join() === "question,reply,seq", "turn keys wrong");
            check(
              r.data.turn.seq === 1 && r.data.turn.reply.startsWith("Answer 1:") && r.data.ended === false,
              "turn wrong",
            );
            const [call] = await lastCalls(1);
            check(call.task === "persona" && call.scenarioInSystem === true, "the model did not receive the scenario");
            check(call.scenarioInChat === false && call.historyPairs === 0, "scenario in chat turns or wrong history");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "the second question carries the first exchange as history",
          async () => {
            const r = await ask(sessionOne, "  Why did you pick that one?  ");
            check(
              r.status === 200 && r.data.turn.seq === 2 && r.data.turn.reply.startsWith("Answer 2:"),
              "turn 2 wrong",
            );
            check(r.data.turn.question === "Why did you pick that one?", "question not trimmed");
            const [call] = await lastCalls(1);
            check(call.historyPairs === 1 && call.scenarioInSystem === true, `history pairs ${call.historyPairs}`);
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "invalid questions and wrong content types are refused without spending",
          async () => {
            callsBefore = (await aiCalls()).length;
            for (const [label, question] of [
              ["empty", ""],
              ["whitespace", "   \n "],
              ["too long", "x".repeat(501)],
              ["not a string", 42],
            ]) {
              const r = await ask(sessionOne, question);
              check(r.status === 400 && r.data?.error === "invalid", `${label}: ${r.status}`);
            }
            const missing = await api(sessionApi(sessionOne, "turns"), { json: {} });
            check(missing.status === 400, `missing: ${missing.status}`);
            const form = await api(sessionApi(sessionOne, "turns"), {
              body: "question=hello",
              contentType: "application/x-www-form-urlencoded",
            });
            check(form.status === 415, `form post: ${form.status}`);
            const plain = await api(sessionApi(sessionOne, "turns"), {
              body: '{"question":"hi"}',
              contentType: "text/plain",
            });
            check(plain.status === 415, `text/plain: ${plain.status}`);
            const broken = await api(sessionApi(sessionOne, "turns"), { body: "{not json" });
            check(broken.status === 400, `malformed JSON: ${broken.status}`);
            const retryForm = await api(sessionApi(sessionOne, "retry"), { body: "", contentType: "text/plain" });
            check(retryForm.status === 415, `retry with text/plain: ${retryForm.status}`);
            check((await aiCalls()).length === callsBefore, "a refused request reached the AI");
            const page = await pageOf(`/rehearsal/${sessionOne}`);
            check(page.text.includes("Questions used: 2 of 8"), "refused questions consumed the cap");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "a failed reply keeps the question, blocks a new one, and a retry does not use another question",
          async () => {
            await fake("/__mode?set=http500");
            const failed = await ask(sessionOne, "Third question, which will fail");
            check(failed.status === 502 && failed.data.error === "ai_failed", `status ${failed.status}`);
            check(
              failed.data.turn?.seq === 3 && failed.data.turn.reply === null,
              "saved turn missing from the failure",
            );
            await fake("/__mode?set=ok");
            let page = await pageOf(`/rehearsal/${sessionOne}`);
            check(
              page.text.includes("Third question, which will fail") && page.text.includes("Try again"),
              "no retry state",
            );
            check(page.text.includes("Questions used: 3 of 8"), "question not counted once");
            callsBefore = (await aiCalls()).length;
            const blocked = await ask(sessionOne, "Fourth question while the third is unanswered");
            check(blocked.status === 409 && blocked.data.error === "reply_pending", `pending: ${blocked.status}`);
            check((await aiCalls()).length === callsBefore, "a blocked question reached the AI");
            const retried = await api(sessionApi(sessionOne, "retry"));
            check(retried.status === 200 && retried.data.turn.seq === 3, `retry: ${retried.status}`);
            check(retried.data.turn.reply.startsWith("Answer 3:"), "retry reply wrong");
            page = await pageOf(`/rehearsal/${sessionOne}`);
            check(page.text.includes("Questions used: 3 of 8"), "retry consumed another question");
            check(
              countOf(page.text, "You · question") === 3,
              `expected 3 questions, saw ${countOf(page.text, "You · question")}`,
            );
            const nothing = await api(sessionApi(sessionOne, "retry"));
            check(
              nothing.status === 409 && nothing.data.error === "nothing_to_retry",
              `nothing to retry: ${nothing.status}`,
            );
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "a reply that claims validation or leaks the setup is never stored",
          async () => {
            await fake("/__mode?set=viability");
            const bad = await ask(sessionOne, "Fourth question");
            check(
              bad.status === 502 && bad.data.error === "invalid_output" && bad.data.turn.reply === null,
              `viability: ${bad.status}`,
            );
            await fake("/__mode?set=leak");
            const leak = await api(sessionApi(sessionOne, "retry"));
            check(leak.status === 502 && leak.data.error === "invalid_output", `leak: ${leak.status}`);
            const page = await pageOf(`/rehearsal/${sessionOne}`);
            check(!/validated|As an AI/.test(page.text), "a rejected reply reached the page");
            await fake("/__mode?set=ok");
            const good = await api(sessionApi(sessionOne, "retry"));
            check(
              good.status === 200 && good.data.turn.seq === 4 && good.data.turn.reply.startsWith("Answer 4:"),
              "recovery failed",
            );
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "a double-submit sends one question",
          async () => {
            callsBefore = (await aiCalls()).length;
            await fake("/__mode?set=slow&ms=1200");
            const [a, b] = await Promise.all([ask(sessionOne, "Fifth question"), ask(sessionOne, "Fifth question")]);
            await fake("/__mode?set=ok");
            const statuses = [a.status, b.status].sort();
            check(statuses.join() === "200,409", `statuses ${statuses}`);
            check((await aiCalls()).length === callsBefore + 1, "the duplicate reached the AI");
            const page = await pageOf(`/rehearsal/${sessionOne}`);
            check(page.text.includes("Questions used: 5 of 8"), "double-submit used two questions");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "ending early freezes the transcript, is idempotent, and refuses further questions",
          async () => {
            const end = await api(sessionApi(sessionOne, "end"));
            check(end.status === 200 && end.data.ended === true, `end: ${end.status}`);
            const again = await api(sessionApi(sessionOne, "end"));
            check(again.status === 200, `second end: ${again.status}`);
            callsBefore = (await aiCalls()).length;
            const late = await ask(sessionOne, "A question after the end");
            check(late.status === 409 && late.data.error === "not_active", `late question: ${late.status}`);
            const retry = await api(sessionApi(sessionOne, "retry"));
            check(retry.status === 409 && retry.data.error === "not_active", `late retry: ${retry.status}`);
            check((await aiCalls()).length === callsBefore, "an ended session reached the AI");
            const page = await pageOf(`/rehearsal/${sessionOne}`);
            check(
              page.text.includes("Session ended") && page.text.includes("You ended the session early"),
              "ended copy missing",
            );
            check(!page.text.includes('id="question"'), "the question box is still offered");
            check(
              page.text.includes("Questions used: 5 of 8") && page.text.includes("Answer 4:"),
              "transcript missing",
            );
            const list = await pageOf("/rehearsal");
            check(
              list.text.includes("Past sessions (1)") &&
                list.text.includes("5 questions") &&
                list.text.includes("Ended early"),
              "past session missing",
            );
            check(list.text.includes("Choose an assumption (3)"), "a new session cannot be started");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "eight questions end the session automatically and a ninth is refused",
          async () => {
            const start = await startRehearsal(rehearsable[1]);
            sessionTwo = sessionIdFrom(start.location);
            check(sessionTwo !== "" && sessionTwo !== sessionOne, `second session: ${start.location}`);
            for (let n = 1; n <= 8; n++) {
              const r = await ask(sessionTwo, `Question number ${n}`);
              check(r.status === 200 && r.data.turn.seq === n, `turn ${n}: ${r.status}`);
              check(r.data.ended === (n === 8), `turn ${n}: ended=${r.data.ended}`);
            }
            callsBefore = (await aiCalls()).length;
            const ninth = await ask(sessionTwo, "Question number 9");
            check(
              ninth.status === 409 && ninth.data.error === "not_active",
              `ninth: ${ninth.status} ${ninth.data?.error}`,
            );
            check((await aiCalls()).length === callsBefore, "the ninth question reached the AI");
            const page = await pageOf(`/rehearsal/${sessionTwo}`);
            check(
              page.text.includes("Questions used: 8 of 8") && page.text.includes("You used all your questions"),
              "cap copy missing",
            );
            check(!page.text.includes('id="question"'), "the question box is still offered after the cap");
            const [call] = await lastCalls(1);
            check(call.historyPairs === 7, `eighth call saw ${call.historyPairs} earlier pairs`);
            const end = await api(sessionApi(sessionTwo, "end"));
            check(end.status === 200, "ending an auto-ended session failed");
            const list = await pageOf("/rehearsal");
            check(
              list.text.includes("Past sessions (2)") && list.text.includes("Ended at the question limit"),
              "cap session not listed",
            );
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "malformed and unknown session ids are handled",
          async () => {
            const bad = await api(sessionApi("not-a-uuid", "turns"), { json: { question: "hi" } });
            check(bad.status === 404, `malformed id: ${bad.status}`);
            const ghost = await api(sessionApi("33333333-3333-3333-3333-333333333333", "turns"), {
              json: { question: "hi" },
            });
            check(ghost.status === 404 && ghost.data.error === "not_found", `unknown id: ${ghost.status}`);
            const end = await api(sessionApi("33333333-3333-3333-3333-333333333333", "end"));
            check(end.status === 404, `unknown end: ${end.status}`);
            const page = await request("/rehearsal/not-a-uuid");
            check(page.status === 302 && page.location === "/rehearsal", `malformed page: ${page.status}`);
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "scoring refuses an unfinished session, bad ids and non-JSON bodies, without spending AI",
          async () => {
            const start = await startRehearsal(rehearsable[2]);
            zeroSession = sessionIdFrom(start.location);
            check(zeroSession !== "", `third start: ${start.location}`);
            callsBefore = (await aiCalls()).length;
            const early = await api(sessionApi(zeroSession, "score"));
            check(early.status === 409 && early.data.error === "not_ended", `active: ${early.status}`);
            const form = await api(sessionApi(zeroSession, "score"), { body: "", contentType: "text/plain" });
            check(form.status === 415, `non-JSON: ${form.status}`);
            const ghost = await api(sessionApi(NIL_ID, "score"));
            check(ghost.status === 404 && ghost.data.error === "not_found", `unknown id: ${ghost.status}`);
            const bad = await api(sessionApi("not-a-uuid", "score"));
            check(bad.status === 404, `malformed id: ${bad.status}`);
            const page = await request(`/rehearsal/${zeroSession}/scorecard`);
            check(page.status === 302 && page.location === `/rehearsal/${zeroSession}`, `page: ${page.location}`);
            const malformed = await request("/rehearsal/not-a-uuid/scorecard");
            check(
              malformed.status === 302 && malformed.location === "/rehearsal",
              `malformed page: ${malformed.status}`,
            );
            check((await aiCalls()).length === callsBefore, "an unscorable request reached the AI");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "a session ended before any question is 'insufficient': no assessment and no AI call",
          async () => {
            const end = await api(sessionApi(zeroSession, "end"));
            check(end.status === 200, `end: ${end.status}`);
            callsBefore = (await aiCalls()).length;
            const score = await api(sessionApi(zeroSession, "score"));
            check(score.status === 200 && score.data.status === "insufficient", `score: ${JSON.stringify(score.data)}`);
            const again = await api(sessionApi(zeroSession, "score"));
            check(again.data?.status === "insufficient", `repeat: ${JSON.stringify(again.data)}`);
            check((await aiCalls()).length === callsBefore, "scoring an empty session reached the AI");
            const page = await pageOf(`/rehearsal/${zeroSession}/scorecard`);
            const text = flat(page.text);
            check(page.status === 200 && text.includes("Not enough transcript to score"), "insufficient copy missing");
            check(
              !text.includes("had nothing flagged") && !text.includes("Try asking it like this"),
              "an assessment appeared",
            );
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "ending a session spends no scoring call, and a never-scored session shows the scoring state",
          async () => {
            // sessionThree has questions with known flaws; the fake flags "would you" and "don't you think".
            const start = await startRehearsal(rehearsable[2]);
            sessionThree = sessionIdFrom(start.location);
            check(sessionThree !== "" && sessionThree !== zeroSession, `fourth start: ${start.location}`);
            for (const question of [
              "Would you pay for a left-handed trowel?",
              "Don't you think left-handed tools are underserved?",
              "What did you do the last time you bought a trowel?",
            ]) {
              const r = await ask(sessionThree, question);
              check(r.status === 200, `ask: ${r.status}`);
            }
            callsBefore = (await aiCalls()).length;
            const end = await api(sessionApi(sessionThree, "end"));
            check(end.status === 200, `end: ${end.status}`);
            const page = await pageOf(`/rehearsal/${sessionThree}/scorecard`);
            const text = flat(page.text);
            check(page.status === 200, `page: ${page.status}`);
            check(text.includes("Scoring your questions. This can take up to 30 seconds"), "scoring state missing");
            check(
              !text.includes("Questions to look at again") && !text.includes("Beta scoring"),
              "a scorecard appeared early",
            );
            check(!text.includes("Would you pay"), "the page props or markup carried the founder's questions");
            check((await aiCalls()).length === callsBefore, "ending or viewing spent a scoring call");
            const chat = await pageOf(`/rehearsal/${sessionThree}`);
            check(
              chat.text.includes(`/rehearsal/${sessionThree}/scorecard`),
              "no link to the scorecard from the ended chat",
            );
            check(chat.text.includes("See your scorecard"), "scorecard call to action missing");
            const list = await pageOf("/rehearsal");
            check(list.text.includes(`/rehearsal/${sessionThree}/scorecard`), "no scorecard link in past sessions");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "a failed scoring (provider error, junk, viability claim, unknown turn) is saved, leaks nothing and can be retried",
          async () => {
            const cases = [
              ["http500", /couldn.t reach the AI service/],
              ["garbage", /usable shape/],
              ["viability", /usable shape/],
              ["unknown_claim", /usable shape/],
              ["short", /usable shape/],
            ];
            for (const [mode, copy] of cases) {
              await fake(`/__mode?set=${mode}`);
              callsBefore = (await aiCalls()).length;
              const r = await api(sessionApi(sessionThree, "score"));
              check(r.status === 200 && r.data.status === "failed", `${mode}: ${JSON.stringify(r.data)}`);
              check(copy.test(r.data.message), `${mode}: message was "${r.data.message}"`);
              check((await aiCalls()).length > callsBefore, `${mode}: the model was never asked`);
              const page = await pageOf(`/rehearsal/${sessionThree}/scorecard`);
              const text = flat(page.text);
              check(text.includes("We couldn't score this one"), `${mode}: no failed state`);
              check(copy.test(text), `${mode}: failure copy missing`);
              check(text.includes("Nothing was lost"), `${mode}: reassurance missing`);
              check(!/validated|Asks what you would do|wording suggests/.test(text), `${mode}: rejected output leaked`);
              check(!text.includes("Questions to look at again"), `${mode}: a partial scorecard was shown`);
            }
            await fake("/__mode?set=ok");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "after a failure Retry produces the scorecard: disclaimer first, exact quotes, labels, a rewrite, no viability claim",
          async () => {
            callsBefore = (await aiCalls()).length;
            const r = await api(sessionApi(sessionThree, "score"));
            check(r.status === 200 && r.data.status === "ready", `retry: ${JSON.stringify(r.data)}`);
            const calls = (await aiCalls()).slice(callsBefore);
            check(
              calls.length === 1 && calls[0].task === "score" && calls[0].turnsSent === 3,
              `calls: ${JSON.stringify(calls)}`,
            );
            const page = await pageOf(`/rehearsal/${sessionThree}/scorecard`);
            const text = flat(page.text);
            check(page.status === 200, `page: ${page.status}`);
            const disclaimer = text.indexOf("Beta scoring");
            const summary = text.indexOf("You asked 3 questions");
            check(disclaimer !== -1 && summary !== -1 && disclaimer < summary, "the disclaimer does not come first");
            check(text.includes("scores how you ask, never whether your idea will work"), "disclaimer wording changed");
            check(text.includes("1 of 3 questions had nothing flagged"), "derived count wrong");
            // Quotes are the stored questions, character for character.
            check(text.includes("Would you pay for a left-handed trowel?"), "quote one missing");
            check(text.includes("Don't you think left-handed tools are underserved?"), "quote two missing");
            check(countOf(page.text, 'data-testid="flagged-question"') === 2, "expected two flagged questions");
            check(text.includes("Hypothetical") && text.includes("Leading"), "label names missing");
            check(
              !text.includes("What did you do the last time you bought a trowel?</blockquote>"),
              "an unflagged question was flagged",
            );
            check(countOf(page.text, 'data-testid="rewrite"') === 1, "expected one rewrite");
            check(text.includes("Tell me about the last time you bought a gardening tool."), "rewrite missing");
            check(text.includes("Try asking it like this") && text.includes("Rehearse again"), "next steps missing");
            check(!/validated|proven/i.test(text), "viability wording appeared");
            check(!text.includes("Scoring your questions."), "the scoring state is still showing");
            // Founders keep their own quote exactly even though the page escapes it for HTML.
            check(!text.includes("score out of") && !/\b\d+\s*\/\s*100\b/.test(text), "a numeric score appeared");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "scoring is idempotent: a repeat costs no AI call and the scorecard does not change",
          async () => {
            const before = flat((await pageOf(`/rehearsal/${sessionThree}/scorecard`)).text);
            callsBefore = (await aiCalls()).length;
            for (let i = 0; i < 2; i++) {
              const r = await api(sessionApi(sessionThree, "score"));
              check(r.status === 200 && r.data.status === "ready", `repeat ${i}: ${JSON.stringify(r.data)}`);
            }
            check((await aiCalls()).length === callsBefore, "a repeat score reached the AI");
            const after = flat((await pageOf(`/rehearsal/${sessionThree}/scorecard`)).text);
            check(before === after, "the scorecard changed on repeat");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "a session with nothing to flag still gets a scorecard with a rewrite and an honest note",
          async () => {
            callsBefore = (await aiCalls()).length;
            const r = await api(sessionApi(sessionOne, "score"));
            check(r.status === 200 && r.data.status === "ready", `score: ${JSON.stringify(r.data)}`);
            const [call] = (await aiCalls()).slice(callsBefore);
            check(call.task === "score" && call.turnsSent === 5, `turns sent: ${call?.turnsSent}`);
            const text = flat((await pageOf(`/rehearsal/${sessionOne}/scorecard`)).text);
            check(text.includes("5 of 5 questions had nothing flagged"), "count wrong");
            check(text.includes("Nothing in your questions was clearly flagged"), "no-flags note missing");
            check(
              countOf(text, "Try asking it like this") === 1 && text.includes("as you asked it"),
              "rewrite section missing",
            );
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "two parallel scoring requests cost exactly one AI call; the cap-ended session scores all eight questions",
          async () => {
            await fetch(`${FAKE_AI_URL}/__mode?set=slow&ms=1500`);
            callsBefore = (await aiCalls()).length;
            const [a, b] = await Promise.all([
              api(sessionApi(sessionTwo, "score")),
              api(sessionApi(sessionTwo, "score")),
            ]);
            await fake("/__mode?set=ok");
            const statuses = [a.data?.status, b.data?.status].sort();
            check(statuses.join() === "in_progress,ready", `statuses: ${statuses.join()}`);
            const calls = (await aiCalls()).slice(callsBefore);
            check(
              calls.length === 1 && calls[0].task === "score" && calls[0].turnsSent === 8,
              `calls: ${JSON.stringify(calls)}`,
            );
            const text = flat((await pageOf(`/rehearsal/${sessionTwo}/scorecard`)).text);
            check(text.includes("8 of 8 questions had nothing flagged"), "cap session count wrong");
            const list = await pageOf("/rehearsal");
            check(
              countOf(list.text, "View scorecard") === 4,
              `expected 4 scorecard links, saw ${countOf(list.text, "View scorecard")}`,
            );
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "through the real database API a founder cannot read or write the hidden persona",
          async () => {
            if (!SUPABASE_URL || !SUPABASE_ANON_KEY)
              return { status: 200, location: "(skipped: set SUPABASE_URL and SUPABASE_ANON_KEY)" };
            const token = accessTokenFromJar();
            const rest = async (path, init = {}) => {
              const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
                ...init,
                headers: {
                  apikey: SUPABASE_ANON_KEY,
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                  ...init.headers,
                },
              });
              const text = note(await response.text());
              return { status: response.status, text };
            };
            // Control: the same token can read the founder's own turns, so the refusals below are about the
            // table, not a bad token.
            const own = await rest("rehearsal_turns?select=session_id,seq,question,reply");
            check(
              own.status === 200 && JSON.parse(own.text).length >= 13,
              `own turns: ${own.status} ${own.text.slice(0, 80)}`,
            );
            const scenarios = await rest("rehearsal_scenarios?select=*");
            const refused =
              [401, 403].includes(scenarios.status) || (scenarios.status === 200 && scenarios.text.trim() === "[]");
            check(refused, `scenarios were readable: ${scenarios.status} ${scenarios.text.slice(0, 80)}`);
            const forged = await rest("rehearsal_turns", {
              method: "POST",
              body: JSON.stringify({ session_id: sessionOne, seq: 8, question: "forged" }),
            });
            check([401, 403].includes(forged.status), `a forged turn was accepted: ${forged.status}`);
            const rewrite = await rest(`rehearsal_turns?session_id=eq.${sessionTwo}`, {
              method: "PATCH",
              body: JSON.stringify({ reply: "rewritten" }),
            });
            check(
              [401, 403].includes(rewrite.status) || rewrite.text.trim() === "",
              `a reply was rewritten: ${rewrite.status}`,
            );
            const reopen = await rest(`rehearsal_sessions?id=eq.${sessionOne}`, {
              method: "PATCH",
              body: JSON.stringify({ status: "active", ended_reason: null, ended_at: null }),
            });
            check([401, 403].includes(reopen.status), `a session was reopened: ${reopen.status}`);
            const fn = await rest("rpc/rehearsal_add_turn", {
              method: "POST",
              body: JSON.stringify({ p_session: sessionOne, p_question: "forged" }),
            });
            check([401, 403, 404].includes(fn.status), `a service-only function was callable: ${fn.status}`);
            const start = await rest("rpc/start_rehearsal_session", {
              method: "POST",
              body: JSON.stringify({ p_assumption: rehearsable[2], p_scenario: {} }),
            });
            check([401, 403, 404].includes(start.status), `start_rehearsal_session was callable: ${start.status}`);
            // Scorecards: readable by their owner, writable by nobody but the server.
            const ownCards = await rest("scorecards?select=session_id,status");
            check(
              ownCards.status === 200 && JSON.parse(ownCards.text).some((c) => c.session_id === sessionThree),
              `own scorecards: ${ownCards.status} ${ownCards.text.slice(0, 80)}`,
            );
            const forgedCard = await rest("scorecards", {
              method: "POST",
              body: JSON.stringify({ session_id: sessionOne, status: "ready", summary: "Forged" }),
            });
            check([401, 403].includes(forgedCard.status), `a scorecard was forged: ${forgedCard.status}`);
            for (const table of ["scorecards", "scorecard_flags", "scorecard_rewrites"]) {
              const edit = await rest(`${table}?session_id=eq.${sessionThree}`, {
                method: "PATCH",
                body: JSON.stringify({ session_id: sessionThree }),
              });
              check([401, 403].includes(edit.status), `${table} was editable: ${edit.status}`);
              const remove = await rest(`${table}?session_id=eq.${sessionThree}`, { method: "DELETE" });
              check([401, 403].includes(remove.status), `${table} was deletable: ${remove.status}`);
            }
            const forgedFlag = await rest("scorecard_flags", {
              method: "POST",
              body: JSON.stringify({
                session_id: sessionThree,
                seq: 1,
                label: "leading",
                quote: "x",
                explanation: "x",
              }),
            });
            check([401, 403].includes(forgedFlag.status), `a flag was forged: ${forgedFlag.status}`);
            const claim = await rest("rpc/claim_scorecard", {
              method: "POST",
              body: JSON.stringify({ p_session: sessionOne }),
            });
            check([401, 403, 404].includes(claim.status), `claim_scorecard was callable: ${claim.status}`);
            const store = await rest("rpc/store_scorecard", {
              method: "POST",
              body: JSON.stringify({
                p_session: sessionOne,
                p_status: "ready",
                p_summary: "Forged",
                p_model: null,
                p_error_kind: null,
                p_flags: [],
                p_rewrites: [],
              }),
            });
            check([401, 403, 404].includes(store.status), `store_scorecard was callable: ${store.status}`);
            const page = await pageOf(`/rehearsal/${sessionTwo}`);
            check(countOf(page.text, "You · question") === 8, "the transcript changed through the database API");
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "another founder cannot see, send to, retry, end or start from this founder's rehearsal",
          async () => {
            const founderA = new Map(jar);
            try {
              jar.clear();
              await request("/api/auth/signup", {
                method: "POST",
                form: { email: emailB, password, confirmPassword: password },
              });
              const verified = await followEmailedLink(extractLink(await fetchMail(emailB, /confirm/i)));
              check(verified.location.startsWith("/dashboard"), `second founder not signed in: ${verified.location}`);

              const page = await request(`/rehearsal/${sessionTwo}`);
              check(page.status === 302 && page.location === "/rehearsal", `page: ${page.status} ${page.location}`);
              const own = await request("/rehearsal");
              check(own.status === 302 && own.location === "/project/new", `no project yet: ${own.location}`);
              const card = await request(`/rehearsal/${sessionTwo}/scorecard`);
              check(card.status === 302 && card.location === "/rehearsal", `scorecard page: ${card.status}`);
              check(!card.text.includes("Question number"), "the scorecard page leaked a transcript");
              callsBefore = (await aiCalls()).length;
              for (const action of ["turns", "retry", "end", "score"]) {
                const r = await api(sessionApi(sessionTwo, action), { json: { question: "intrusion" } });
                check(r.status === 404 && r.data?.error === "not_found", `${action}: ${r.status}`);
                check(
                  !r.text.includes("Question number") && !r.text.includes("Answer "),
                  `${action} leaked a transcript`,
                );
              }
              check((await aiCalls()).length === callsBefore, "a stranger's request spent AI");
              const start = await startRehearsal(rehearsable[2]);
              check(start.location === "/rehearsal?startError=assumption_not_found", `start: ${start.location}`);
              check((await aiCalls()).length === callsBefore, "a stranger's start spent AI");
            } finally {
              switchJar(founderA);
            }
            const mine = await pageOf(`/rehearsal/${sessionTwo}`);
            check(mine.status === 200 && mine.text.includes("Questions used: 8 of 8"), "the owner lost access");
            const mineCard = await pageOf(`/rehearsal/${sessionTwo}/scorecard`);
            check(
              mineCard.status === 200 && flat(mineCard.text).includes("8 of 8 questions"),
              "the owner lost the scorecard",
            );
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "the hidden scenario never appeared in any page or API response",
          async () => {
            check(corpus.length > 40, `only ${corpus.length} bodies were collected`);
            check(!corpus.some((body) => body.includes(SCENARIO_MARKER)), "the scenario marker leaked to a client");
            check(
              !corpus.some((body) => /hidden_truths|assumption_reality|speaking_style/.test(body)),
              "scenario field names leaked",
            );
            const personaCalls = (await aiCalls()).filter((c) => c.task === "persona");
            check(personaCalls.length >= 14, `only ${personaCalls.length} persona calls`);
            check(
              personaCalls.every((c) => c.scenarioInSystem && !c.scenarioInChat),
              "the model did not always receive the scenario in the system prompt only",
            );
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
        [
          "every provider call asked for zero data retention, and JSON mode where it expects JSON",
          async () => {
            const calls = await aiCalls();
            check(calls.length > 0, "no provider calls recorded");
            check(
              calls.every((c) => c.dataCollection === "deny"),
              "a call lacked data_collection=deny",
            );
            // Every call is authorised and one of the known tasks; all but persona replies ask for JSON mode.
            check(
              calls.every(
                (c) =>
                  c.authorised &&
                  ["draft", "suggest", "scenario", "persona", "score"].includes(c.task) &&
                  c.jsonMode === (c.task !== "persona"),
              ),
              "unexpected call shape",
            );
            check(
              ["suggest", "scenario", "persona", "score"].every((task) => calls.some((c) => c.task === task)),
              "a task kind was never called",
            );
            return { status: 200, location: "" };
          },
          { status: 200 },
        ],
      ]
    : []),
  ["final signout", post("/api/auth/signout"), { status: 302, location: "/" }],
];

let failed = 0;
for (const [name, run, expected] of steps) {
  let actual;
  try {
    actual = await run();
  } catch (error) {
    actual = { status: 0, location: error instanceof Error ? error.message : String(error) };
  }
  const ok =
    actual.status === expected.status &&
    (expected.location === undefined || actual.location.startsWith(expected.location));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  -> ${actual.status} ${actual.location}`);
  if (!ok) {
    failed++;
    console.log(`      expected ${expected.status} ${expected.location ?? ""}`);
  }
}

console.log(failed ? `\n${failed} step(s) failed` : "\nAll smoke steps passed");
process.exit(failed ? 1 : 0);
