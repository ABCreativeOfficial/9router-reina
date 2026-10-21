// CodeBuddy Intl error classification, second pass (#5024, #5041, #5001, #5005).
//
// Three failure families share the same gateway and used to collapse into one
// generic "illegal request" 400:
//   - 11128 channel verification  -> provider-scoped block, needs a cooldown
//   - 11128 "first message…"      -> request-scoped, must NOT cool the account
//   - 11140 account restricted    -> account frozen, needs a long account lock
// The third also has to survive as a real message: callers must be able to tell
// "fix your request" apart from "this account is frozen upstream".
import { describe, expect, it } from "vitest";

import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import {
  ACCOUNT_RESTRICTED_COOLDOWN_MS,
  CODEBUDDY_ACCOUNT_RESTRICTED_MARKER,
  CODEBUDDY_CHANNEL_MARKER,
} from "../../open-sse/config/errorConfig.js";

const exec = new CodeBuddyIntlExecutor();
const res = (status = 400) => ({ status });

const parse = (body, status = 400) => exec.parseError(res(status), JSON.stringify(body));

// The live restriction body (#5005 comment, 2026-10-18).
const RESTRICTED_BODY = {
  code: 11140,
  msg: "Your account has been restricted due to unusual activity",
  requestId: "0b7a1b4e",
};

// The live WAF/channel body (#5001, #5024, #5041).
const CHANNEL_BODY = {
  code: 11128,
  msg: "request illegal",
  requestId: "2255ef10",
  displayMsg: { en: "Request blocked. Please send it again" },
  displayTips: {
    en: "This call failed channel verification, possibly because it was not sent from an official client.",
  },
  actions: ["EDIT_INPUT", "SUBMIT_FEEDBACK"],
};

describe("11140 account restriction", () => {
  it("classifies the restriction regardless of HTTP status", () => {
    for (const status of [400, 403]) {
      const out = exec.parseError(res(status), JSON.stringify(RESTRICTED_BODY));
      expect(out.status, `status ${status}`).toBe(403);
      expect(out.message).toContain(CODEBUDDY_ACCOUNT_RESTRICTED_MARKER);
      expect(out.message).toContain("11140");
    }
  });

  it("keeps the real upstream message instead of a generic error", () => {
    const out = parse(RESTRICTED_BODY);
    expect(out.message).toContain("Your account has been restricted due to unusual activity");
    expect(out.message).toMatch(/re-login|appeal/i);
    // It must not be mistaken for a channel/verification failure: different fix.
    expect(out.message).not.toContain(CODEBUDDY_CHANNEL_MARKER);
  });

  it("recognises the wording when only display text carries it", () => {
    // Codes drift; the phrase is the authoritative signal.
    const out = exec.parseError(res(403), JSON.stringify({
      code: 0,
      msg: "",
      displayMsg: { en: "Your account has been restricted due to unusual activity" },
    }));
    expect(out.status).toBe(403);
    expect(out.message).toContain(CODEBUDDY_ACCOUNT_RESTRICTED_MARKER);
  });

  it("locks the whole account, not one model, for a long finite window", () => {
    const out = parse(RESTRICTED_BODY);
    const verdict = checkFallbackError(out.status, out.message, 0, "codebuddy-intl");

    expect(verdict.shouldFallback).toBe(true);
    expect(verdict.cooldownMs).toBe(ACCOUNT_RESTRICTED_COOLDOWN_MS);
    expect(verdict.accountScoped).toBe(true);
  });

  it("does not fall back to a second account as if it were a transient error", () => {
    // The lock is per connection; what matters here is that the classification is
    // deterministic and long — a 2-minute 403 default would re-probe the frozen
    // account every couple of minutes (#5041: both accounts gated identically).
    const verdict = checkFallbackError(403, "plain forbidden", 0, "codebuddy-intl");
    expect(verdict.cooldownMs).toBeLessThan(ACCOUNT_RESTRICTED_COOLDOWN_MS);
  });
});

describe("11128 channel verification", () => {
  it("classifies the bare 'request illegal' wording from the live gateway", () => {
    const out = parse(CHANNEL_BODY);
    expect(out.status).toBe(400);
    expect(out.message).toContain(CODEBUDDY_CHANNEL_MARKER);
    expect(out.message).toContain("request illegal");
    expect(out.message).toContain("This call failed channel verification");
  });

  it("classifies the older conversation-id wording", () => {
    const out = parse({ code: 11128, msg: "conversation id missing" });
    expect(out.message).toContain(CODEBUDDY_CHANNEL_MARKER);
  });

  it("classifies the 2026-10-17 unapproved-channel wording", () => {
    const out = parse({ code: 11128, msg: "Illegal API invocation from an unapproved channel" });
    expect(out.message).toContain(CODEBUDDY_CHANNEL_MARKER);
  });

  it("gives the connection a cooldown instead of cooldownMs 0", () => {
    const out = parse(CHANNEL_BODY);
    const verdict = checkFallbackError(out.status, out.message, 0, "codebuddy-intl");

    expect(verdict.shouldFallback).toBe(true);
    expect(verdict.cooldownMs).toBeGreaterThan(0);
    expect(verdict.newBackoffLevel).toBe(1);
    expect(verdict.accountScoped).toBe(true);
  });

  it("escalates the cooldown across repeated blocks (bounded backoff)", () => {
    const out = parse(CHANNEL_BODY);
    const first = checkFallbackError(out.status, out.message, 0, "codebuddy-intl");
    const later = checkFallbackError(out.status, out.message, 6, "codebuddy-intl");
    expect(later.cooldownMs).toBeGreaterThan(first.cooldownMs);
    expect(later.cooldownMs).toBeLessThanOrEqual(5 * 60 * 1000); // BACKOFF_CONFIG.max
  });
});

describe("request-scoped siblings stay request-scoped", () => {
  it("does NOT cool the account for 'first message is not system prompt'", () => {
    const out = parse({ code: 11128, msg: "first message is not system prompt" });
    expect(out.status).toBe(400);
    expect(out.message).toMatch(/system prompt/i);

    const verdict = checkFallbackError(out.status, out.message, 0, "codebuddy-intl");
    expect(verdict.shouldFallback).toBe(false);
    expect(verdict.cooldownMs).toBe(0);
  });

  it("does NOT cool the account for a plain 11103 invalid request", () => {
    const out = parse({ code: 11103, msg: "request illegal" });
    expect(out.message).toMatch(/illegal/i);
    expect(out.message).not.toContain(CODEBUDDY_CHANNEL_MARKER);

    const verdict = checkFallbackError(out.status, out.message, 0, "codebuddy-intl");
    expect(verdict.shouldFallback).toBe(false);
    expect(verdict.cooldownMs).toBe(0);
  });

  it("keeps an unrelated provider's 400 request-scoped", () => {
    const verdict = checkFallbackError(400, "maximum context length exceeded", 0, "openai");
    expect(verdict.shouldFallback).toBe(false);
    expect(verdict.cooldownMs).toBe(0);
  });
});

describe("14003 model busy", () => {
  it("maps to 429 so the rate-limit rules apply", () => {
    const out = parse({ code: 14003, msg: "too many requests" }, 429);
    expect(out.status).toBe(429);
    expect(out.message).toMatch(/too many requests/i);
    expect(checkFallbackError(out.status, out.message).shouldFallback).toBe(true);
  });
});

describe("classification order", () => {
  it("prefers account restriction over the channel marker when both could match", () => {
    // Defensive: a restricted account whose body also mentions verification must
    // surface the restriction; locking for 6h on the wrong diagnosis would hide it.
    const out = parse({
      code: 11140,
      msg: "account restricted due to unusual activity",
      displayTips: { en: "This call failed channel verification" },
    }, 403);
    expect(out.message).toContain(CODEBUDDY_ACCOUNT_RESTRICTED_MARKER);
    expect(out.message).not.toContain(CODEBUDDY_CHANNEL_MARKER);
  });
});
