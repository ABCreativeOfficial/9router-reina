import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { normalizeXingchiUsage } from "../../open-sse/services/usage/xingchi.js";
import { USAGE_SUPPORTED_PROVIDERS, USAGE_APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";
import { parseQuotaData, getRemainingPercentage } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const USAGE_URL = "https://api.xingchiapi.com/v1/usage";
const BILLING_URL = "https://api.xingchiapi.com/v1/sub2api/billing";
const WALLET = {
  balance: 299.997651,
  isValid: true,
  mode: "unrestricted",
  planName: "钱包余额",
  remaining: 299.997651,
  unit: "USD",
  usage: {
    today: { requests: 3, input_tokens: 2259, output_tokens: 18, total_tokens: 2277, cost: 0.004698, actual_cost: 0.002349 },
    total: { requests: 3, input_tokens: 2259, output_tokens: 18, total_tokens: 2277, cost: 0.004698, actual_cost: 0.002349 },
  },
  model_stats: [{ model: "gpt-6.1-sol", requests: 3, total_tokens: 2277, actual_cost: 0.002349 }],
};
const BILLING = {
  object: "sub2api.key_billing", billing_scope: "token",
  group_rate_multiplier: 1, effective_rate_multiplier: 1,
};

function respond(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Xingchi Quota Tracker registration", () => {
  it("is included in the existing API-key quota eligibility lists", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("xingchi");
    expect(USAGE_APIKEY_PROVIDERS).toContain("xingchi");
  });
});

describe("getUsageForProvider(xingchi)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("authenticates both server-side Sub2API endpoints with the saved API key", async () => {
    proxyAwareFetch.mockImplementation(async (url) => respond(url === USAGE_URL ? WALLET : BILLING));

    const usage = await getUsageForProvider({ provider: "xingchi", authType: "apikey", apiKey: "  TEST-KEY  " });
    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("钱包余额");
    expect(usage.quotas["Balance (USD)"]).toMatchObject({
      total: 300,
      used: 0.002349,
      remainingAmount: 299.997651,
      isWalletBalance: true,
    });
    expect(usage.quotas["Balance (USD)"].remainingPercentage).toBeCloseTo(99.999217, 5);
    expect(usage.xingchi).toMatchObject({
      balance: 299.997651, remaining: 299.997651, billingRate: 1,
      today: { requests: 3, totalTokens: 2277, actualCost: 0.002349 },
    });
    expect(usage.xingchi.models[0].model).toBe("gpt-6.1-sol");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    const endpoints = proxyAwareFetch.mock.calls.map(([url]) => url);
    expect(endpoints).toEqual([USAGE_URL, BILLING_URL]);
    for (const [, options] of proxyAwareFetch.mock.calls) {
      expect(options.method).toBe("GET");
      expect(options.headers.Authorization).toBe("Bearer TEST-KEY");
      expect(options.headers.Accept).toBe("application/json");
      expect(options.cache).toBe("no-store");
    }

    const rows = parseQuotaData("xingchi", usage);
    expect(rows).toHaveLength(1);
    expect(rows[0].isCreditBalance).toBe(false);
    expect(rows[0].isWalletBalance).toBe(true);
    expect(rows[0].remainingAmount).toBe(299.997651);
    expect(rows[0].remaining).toBeUndefined();
    // The shared integer helper remains unchanged for other providers; the
    // wallet table row explicitly preserves the fractional percentage.
    expect(rows[0].remainingPercentage).toBeCloseTo(99.999217, 5);
  });

  it("continues showing usage when optional billing returns 404", async () => {
    proxyAwareFetch.mockImplementation(async (url) => url === USAGE_URL ? respond(WALLET) : respond({}, 404));
    const usage = await getUsageForProvider({ provider: "xingchi", apiKey: "TEST-KEY" });
    expect(usage.quotas["Balance (USD)"].total).toBe(300);
    expect(usage.xingchi.billingRate).toBeNull();
  });

  it("rejects missing credentials without making remote requests", async () => {
    const usage = await getUsageForProvider({ provider: "xingchi" });
    expect(usage.message).toMatch(/API key not available/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("returns an auth warning if usage is denied even if billing works", async () => {
    proxyAwareFetch.mockImplementation(async (url) => url === USAGE_URL ? respond({}, 403) : respond(BILLING));
    const usage = await getUsageForProvider({ provider: "xingchi", apiKey: "TEST-KEY" });
    expect(usage.message).toContain("HTTP 403");
    expect(usage.quotas).toBeUndefined();
  });

  it("does not hide the wallet if the billing request fails to connect", async () => {
    proxyAwareFetch.mockImplementation(async (url) => {
      if (url === BILLING_URL) throw new Error("timeout");
      return respond(WALLET);
    });
    const usage = await getUsageForProvider({ provider: "xingchi", apiKey: "TEST-KEY" });
    expect(usage.xingchi.balance).toBe(299.997651);
    expect(usage.xingchi.billingRate).toBeNull();
  });
});

describe("Sub2API quota normalization", () => {
  it("renders a real finite API-key quota, never treating absolute remaining as a percentage", () => {
    const output = normalizeXingchiUsage({
      planName: "Key cap", remaining: 70, unit: "USD",
      quota: { used: 30, limit: 100, remaining: 70, unit: "USD" },
    });
    const row = parseQuotaData("xingchi", output)[0];
    expect(row).toMatchObject({ used: 30, total: 100, isCreditBalance: false });
    expect(row.remaining).toBeUndefined();
    expect(getRemainingPercentage(row)).toBe(70);
  });

  it("creates independent subscription windows and skips unlimited/undefined limits", () => {
    const output = normalizeXingchiUsage({
      planName: "Subscription", remaining: -1, unit: "USD",
      subscription: { daily_usage_usd: 3, daily_limit_usd: 10, weekly_usage_usd: 15, weekly_limit_usd: 50, monthly_limit_usd: 0 },
    });
    expect(Object.keys(output.quotas)).toEqual(["Daily subscription (USD)", "Weekly subscription (USD)"]);
    expect(output.xingchi.balance).toBeNull();
    expect(output.quotas["Weekly subscription (USD)"].used).toBe(15);
  });

  it("tracks rate-limited windows and their reset date", () => {
    const output = normalizeXingchiUsage({
      planName: "Rate limited", remaining: 2, unit: "USD",
      rate_limits: [{ window: "5h", used: 3, limit: 5, reset_at: "2026-11-21T00:00:00Z" }],
    });
    expect(output.quotas["Rate limit (5h)"]).toMatchObject({
      used: 3, total: 5, resetAt: "2026-11-21T00:00:00.000Z",
    });
    expect(output.quotas["Balance (USD)"]).toBeUndefined();
  });

  it("calculates New API-style balance ratio using actual charges, not list-price cost", () => {
    const output = normalizeXingchiUsage(WALLET);
    expect(output.quotas["Balance (USD)"].total).toBe(300);
    expect(output.quotas["Balance (USD)"].used).toBe(0.002349);
    expect(output.quotas["Balance (USD)"].remainingAmount).toBe(299.997651);
    expect(output.quotas["Balance (USD)"].remainingPercentage).toBeCloseTo(99.999217, 5);
    expect(output.xingchi.total.cost).toBe(0.004698);
    expect(output.xingchi.total.actualCost).toBe(0.002349);
  });

  it("does not fabricate a percentage bar when actual charged spending is missing", () => {
    const output = normalizeXingchiUsage({
      ...WALLET,
      usage: { total: { requests: 2, cost: 0.25 } },
    });
    expect(output.quotas["Balance (USD)"]).toMatchObject({
      total: 299.997651,
      isCreditBalance: true,
      remainingPercentage: 100,
    });
    expect(output.quotas["Balance (USD)"].isWalletBalance).toBeUndefined();
  });

  it("shows depleted wallet as 0% with real recorded charges", () => {
    const output = normalizeXingchiUsage({ ...WALLET, balance: 0 });
    expect(output.quotas["Balance (USD)"].remainingPercentage).toBe(0);
    expect(output.quotas["Balance (USD)"].total).toBe(0.002349);
  });

  it("ignores malformed usage instead of producing false zero-value limits", () => {
    expect(normalizeXingchiUsage(null)).toBeNull();
    expect(normalizeXingchiUsage({ isValid: false })).toBeNull();
    const output = normalizeXingchiUsage({ quota: { limit: 0, used: 100 }, mode: "quota_limited" });
    expect(output.quotas).toEqual({});
  });
});
