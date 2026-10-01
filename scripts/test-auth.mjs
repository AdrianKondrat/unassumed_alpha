// Offline checks for src/lib/auth.ts (open-redirect guard, validation, error copy). No network.
// Run: npm run test:auth
import {
  MIN_PASSWORD_LENGTH,
  authErrorMessage,
  errorRedirect,
  resetPasswordSchema,
  safeNext,
  signInSchema,
  signUpSchema,
} from "../src/lib/auth.ts";

const steps = [];
const step = (name, fn) => steps.push([name, fn]);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

for (const [input, expected] of [
  ["/dashboard", "/dashboard"],
  ["/project/new?x=1", "/project/new?x=1"],
  ["/auth/reset-password", "/auth/reset-password"],
  [undefined, "/dashboard"],
  [null, "/dashboard"],
  ["", "/dashboard"],
  ["https://evil.example", "/dashboard"],
  ["http://evil.example/x", "/dashboard"],
  ["//evil.example", "/dashboard"],
  ["/\\evil.example", "/dashboard"],
  ["\\\\evil.example", "/dashboard"],
  ["javascript:alert(1)", "/dashboard"],
  ["dashboard", "/dashboard"],
  ["/ok\r\nSet-Cookie: x=1", "/dashboard"],
  ["/ok\u0000", "/dashboard"],
]) {
  step(`safeNext(${JSON.stringify(input)})`, () => {
    const actual = safeNext(input);
    assert(actual === expected, `expected ${expected}, got ${actual}`);
  });
}
step("safeNext honours a custom fallback", () => assert(safeNext("//x", "/home") === "/home", "fallback ignored"));

step("errorRedirect encodes the message and respects an existing query", () => {
  assert(errorRedirect("/a", "x y&z") === "/a?error=x%20y%26z", "bad encoding");
  assert(errorRedirect("/a?b=1", "m") === "/a?b=1&error=m", "bad separator");
});

step("sign-in schema normalises email and requires a password", () => {
  const ok = signInSchema.safeParse({ email: "  Founder@Example.COM ", password: "x" });
  assert(ok.success && ok.data.email === "founder@example.com", "email not normalised");
  assert(!signInSchema.safeParse({ email: "nope", password: "x" }).success, "bad email accepted");
  assert(!signInSchema.safeParse({ email: "a@b.co", password: "" }).success, "empty password accepted");
  assert(!signInSchema.safeParse({ email: "a@b.co" }).success, "missing password accepted");
});
step("sign-up schema enforces length and matching confirmation", () => {
  const short = "x".repeat(MIN_PASSWORD_LENGTH - 1);
  const good = "x".repeat(MIN_PASSWORD_LENGTH);
  assert(!signUpSchema.safeParse({ email: "a@b.co", password: short }).success, "short password accepted");
  assert(signUpSchema.safeParse({ email: "a@b.co", password: good }).success, "valid sign-up rejected");
  assert(
    !signUpSchema.safeParse({ email: "a@b.co", password: good, confirmPassword: good + "!" }).success,
    "mismatch accepted",
  );
  assert(!signUpSchema.safeParse({ email: "a@b.co", password: "x".repeat(73) }).success, "73 chars accepted");
});
step("reset schema enforces the same password rules", () => {
  assert(!resetPasswordSchema.safeParse({ password: "short" }).success, "short accepted");
  assert(
    resetPasswordSchema.safeParse({ password: "long-enough-1", confirmPassword: "long-enough-1" }).success,
    "valid rejected",
  );
});

step("auth error copy is friendly and never forwards raw provider text", () => {
  for (const code of [
    "invalid_credentials",
    "email_not_confirmed",
    "otp_expired",
    "over_email_send_rate_limit",
    "weak_password",
    "same_password",
    "something_new",
  ]) {
    const message = authErrorMessage({ code, message: "RAW provider message with internals" });
    assert(message.length > 10 && !message.includes("RAW"), `bad copy for ${code}`);
  }
  assert(authErrorMessage(undefined) === authErrorMessage({ code: "unknown" }), "default copy differs");
});

let failed = 0;
for (const [name, fn] of steps) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(failed ? `\n${failed} step(s) failed` : `\nAll ${steps.length} auth helper checks passed`);
process.exit(failed ? 1 : 0);
