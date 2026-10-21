// Account-lock scope for the two CodeBuddy Intl classifications.
//
// markAccountUnavailable() writes a `modelLock_*` field on the connection. The
// default scope is the model that happened to fail, which is right for a model
// cap but wrong for a failure of the credential itself:
//   - 11140 freezes the account      -> every model is refused identically
//   - 11128 channel verification is provider/IP-scoped (#5024/#5041)
// A per-model lock would leave the router probing the rest of the catalog one
// 4xx at a time, so both must produce `modelLock___all`.
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");
const { CodeBuddyIntlExecutor } = await import("../../open-sse/executors/codebuddy-intl.js");
const { ACCOUNT_RESTRICTED_COOLDOWN_MS } = await import("../../open-sse/config/errorConfig.js");

const executor = new CodeBuddyIntlExecutor();
const parse = (body, status = 400) => executor.parseError({ status }, JSON.stringify(body));

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getProviderConnections.mockResolvedValue([{
    id: "cbai-a",
    provider: "codebuddy-intl",
    name: "cbai-a",
    backoffLevel: 0,
  }]);
});

describe("markAccountUnavailable — CodeBuddy Intl scope", () => {
  it("locks the whole account for 11140 and keeps the real message", async () => {
    const parsed = parse({ code: 11140, msg: "Your account has been restricted due to unusual activity" }, 403);

    await markAccountUnavailable("cbai-a", parsed.status, parsed.message, "codebuddy-intl", "glm-5.2");

    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(update).toHaveProperty("modelLock___all");
    expect(update).not.toHaveProperty("modelLock_glm-5.2");
    expect(update.errorCode).toBe(403);
    // The upstream wording survives into the connection record.
    expect(update.lastError).toContain("unusual activity");

    const lockMs = new Date(update.modelLock___all).getTime() - Date.now();
    expect(lockMs).toBeGreaterThan(ACCOUNT_RESTRICTED_COOLDOWN_MS - 60_000);
  });

  it("locks the whole account for a channel-verification 11128", async () => {
    const parsed = parse({
      code: 11128,
      msg: "request illegal",
      displayTips: { en: "This call failed channel verification" },
    });

    await markAccountUnavailable("cbai-a", parsed.status, parsed.message, "codebuddy-intl", "glm-5.2");

    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(update).toHaveProperty("modelLock___all");
    expect(update).not.toHaveProperty("modelLock_glm-5.2");
    expect(update.backoffLevel).toBe(1);

    const lockMs = new Date(update.modelLock___all).getTime() - Date.now();
    expect(lockMs).toBeGreaterThan(0);
  });

  it("keeps a request-scoped 11128 model-scoped and unlocked", async () => {
    // "first message is not system prompt" is the request's fault. The account
    // must stay in rotation, and checkFallbackError returns shouldFallback false,
    // so no lock at all is written.
    const parsed = parse({ code: 11128, msg: "first message is not system prompt" });

    const verdict = await markAccountUnavailable(
      "cbai-a", parsed.status, parsed.message, "codebuddy-intl", "glm-5.2",
    );

    expect(verdict.shouldFallback).toBe(false);
    expect(dbMocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("keeps an ordinary account-scoped 403 model-scoped (no behaviour change)", async () => {
    await markAccountUnavailable("cbai-a", 403, "plain forbidden", "codebuddy-intl", "glm-5.2");

    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(update).toHaveProperty("modelLock_glm-5.2");
    expect(update).not.toHaveProperty("modelLock___all");
  });
});
