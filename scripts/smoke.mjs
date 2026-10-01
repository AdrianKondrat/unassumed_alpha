// Smoke test: proves the built app, the Cloudflare adapter and the Supabase auth flow still work together,
// including email verification and password reset by following the links actually emailed.
// Zero dependencies on purpose. Run against a live server with a local Supabase (email confirmations on):
//   BASE_URL=http://localhost:4321 MAIL_URL=http://127.0.0.1:54324 node scripts/smoke.mjs

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4321";
const MAIL_URL = process.env.MAIL_URL ?? "http://127.0.0.1:54324";
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

const steps = [
  ["home renders", () => request("/"), { status: 200 }],
  ["dashboard redirects anonymous user", () => request("/dashboard"), { status: 302, location: "/auth/signin" }],
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
