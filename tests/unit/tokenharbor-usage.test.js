import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { normalizeTokenHarborAllowance } from "../../open-sse/services/usage/tokenharbor.js";
import { USAGE_SUPPORTED_PROVIDERS, USAGE_APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";
import { parseQuotaData, getRemainingPercentage } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const ENDPOINT = "https://tokenharbor.ai/api/cli/free-tier";
const REAL_SHAPE = {
  plan_name: null,
  models: ["deepseek-v4-flash", "mimo-v2.6-flash", "mimo-v2.5", "deepseek-v4.1-flash"],
  models_enabled: true,
  on_plan: false,
  campaign: false,
  req_used: 187,
  reset_at: "2026-11-22T18:05:52.654917+00:00",
  unlocked: false,
  used_pct: 16,
  activated: true,
  exhausted: false,
  rpm_limit: 1000000,
  buffer_pct: 0,
  plan_used_pct: 0,
  base_share_pct: 100,
  period_ends_at: "2026-11-22T18:05:52.654917+00:00",
  plan_exhausted: false,
  period_started_at: "2026-11-15T18:05:52.654917+00:00",
};

function respond(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Token Harbor Quota Tracker registry", () => {
  it("is included for API-key connections without touching the request executor", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("tokenharbor");
    expect(USAGE_APIKEY_PROVIDERS).toContain("tokenharbor");
  });
});

describe("getUsageForProvider(tokenharbor)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queries the official API once using the existing stored key and proxy options", async () => {
    proxyAwareFetch.mockResolvedValueOnce(respond(REAL_SHAPE));
    const proxyOptions = { connectionProxyEnabled: false, strictProxy: false };
    const output = await getUsageForProvider({ provider: "tokenharbor", authType: "apikey", apiKey: " TEST-ONLY-KEY " }, proxyOptions);

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, options, proxy] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(options.method).toBe("GET");
    expect(options.headers).toMatchObject({ Authorization: "Bearer TEST-ONLY-KEY", Accept: "application/json" });
    expect(options.cache).toBe("no-store");
    expect(proxy).toBe(proxyOptions);

    expect(output.quotas["Free models (7d)"]).toMatchObject({
      used: 16, total: 100, remainingPercentage: 84,
      resetAt: "2026-11-22T18:05:52.654Z",
    });
    expect(output.quotas["Pass allowance (7d)"]).toBeUndefined();
    expect(output.tokenharbor).toMatchObject({
      freeModelsEnabled: true, freeUsedPct: 16, freeExhausted: false,
      requestsUsed: 187, onPlan: false,
    });
    expect(output.tokenharbor.models).toEqual(REAL_SHAPE.models); // keep bare IDs

    const rows = parseQuotaData("tokenharbor", output);
    expect(rows).toHaveLength(1);
    expect(getRemainingPercentage(rows[0])).toBe(84);
  });

  it("rejects missing API keys without contacting the network", async () => {
    const usage = await getUsageForProvider({ provider: "tokenharbor" });
    expect(usage.message).toMatch(/key not available/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("handles unauthorized keys, email-verification errors and generic upstream errors", async () => {
    proxyAwareFetch.mockResolvedValueOnce(respond({ error: "unauthorized" }, 401));
    expect((await getUsageForProvider({ provider: "tokenharbor", apiKey: "TEST" })).message).toContain("401");

    proxyAwareFetch.mockResolvedValueOnce(respond({ error: "email_verification_required" }, 403));
    expect((await getUsageForProvider({ provider: "tokenharbor", apiKey: "TEST" })).message).toMatch(/email verification/i);

    proxyAwareFetch.mockResolvedValueOnce(respond({ error: "lookup_failed" }, 500));
    expect((await getUsageForProvider({ provider: "tokenharbor", apiKey: "TEST" })).message).toContain("HTTP 500");
  });

  it("handles networking errors and invalid JSON without leaking the upstream response", async () => {
    proxyAwareFetch.mockRejectedValueOnce(new Error("Do not echo a secret key"));
    const error = await getUsageForProvider({ provider: "tokenharbor", apiKey: "TEST" });
    expect(error.message).toMatch(/request failed/i);
    expect(error.message).not.toContain("secret key");

    proxyAwareFetch.mockResolvedValueOnce(respond({ no_used_pct: 16 }));
    const malformed = await getUsageForProvider({ provider: "tokenharbor", apiKey: "TEST" });
    expect(malformed.message).toMatch(/invalid free-tier/i);
  });
});

describe("Token Harbor allowance normalization", () => {
  it("shows a separate Pass window only for active Pass subscribers", () => {
    const output = normalizeTokenHarborAllowance({
      ...REAL_SHAPE, on_plan: true, plan_name: "Office Pass", plan_used_pct: 37,
    });
    expect(Object.keys(output.quotas)).toEqual(["Free models (7d)", "Pass allowance (7d)"]);
    expect(output.plan).toBe("Office Pass");
    expect(getRemainingPercentage(parseQuotaData("tokenharbor", output)[1])).toBe(63);
  });

  it("keeps the official exhausted flag authoritative even with rounded percent", () => {
    const output = normalizeTokenHarborAllowance({ ...REAL_SHAPE, used_pct: 99, exhausted: true });
    expect(output.quotas["Free models (7d)"].used).toBe(99);
    expect(output.quotas["Free models (7d)"].remainingPercentage).toBe(0);
    expect(output.tokenharbor.freeExhausted).toBe(true);
  });

  it("does not confuse disabled free models with exhausted allowance", () => {
    const output = normalizeTokenHarborAllowance({ ...REAL_SHAPE, models_enabled: false });
    expect(output.tokenharbor.freeModelsEnabled).toBe(false);
    expect(output.tokenharbor.freeExhausted).toBe(false);
    expect(output.quotas["Free models (7d)"].remainingPercentage).toBe(84);
  });

  it("does not fabricate a reset before the first free request", () => {
    const output = normalizeTokenHarborAllowance({
      ...REAL_SHAPE, activated: false, used_pct: 0,
      reset_at: null, period_ends_at: null,
    });
    expect(output.quotas["Free models (7d)"].remainingPercentage).toBe(100);
    expect(output.quotas["Free models (7d)"].resetAt).toBeNull();
    expect(output.tokenharbor.activated).toBe(false);
  });

  it("ignores internal fields and never treats weekly percentages as a USD wallet", () => {
    const output = normalizeTokenHarborAllowance(REAL_SHAPE);
    expect(output.quotas).toHaveProperty("Free models (7d)");
    expect(output.quotas).not.toHaveProperty("Balance (USD)");
    expect(JSON.stringify(output)).not.toContain("rpm_limit");
    expect(JSON.stringify(output)).not.toContain("unlocked");
    expect(JSON.stringify(output)).not.toContain("buffer_pct");
    expect(output.tokenharbor.requestsUsed).toBe(187);
  });

  it("rejects missing or out-of-range percentages rather than showing fake 0%", () => {
    expect(normalizeTokenHarborAllowance({})).toBeNull();
    expect(normalizeTokenHarborAllowance({ used_pct: 150 })).toBeNull();
    expect(normalizeTokenHarborAllowance({ used_pct: -1 })).toBeNull();
    expect(normalizeTokenHarborAllowance(null)).toBeNull();
  });

  it("does not rewrite model IDs or infer which require :free suffix", () => {
    const output = normalizeTokenHarborAllowance({
      ...REAL_SHAPE,
      models: ["deepseek-v4-flash", "deepseek-v4-flash", "mimo-v2.6-flash", "deepseek-v4.1-flash:free"],
    });
    expect(output.tokenharbor.models).toEqual(["deepseek-v4-flash", "mimo-v2.6-flash", "deepseek-v4.1-flash:free"]);
  });
});
