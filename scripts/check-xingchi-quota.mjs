// Offline test, no npm install and no real Xingchi key necessary.
// Run from repository root: node scripts/check-xingchi-quota.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getXingchiUsage, normalizeXingchiUsage } from "../open-sse/services/usage/xingchi.js";
import REGISTRY from "../open-sse/providers/registry/index.js";

const provider = REGISTRY.find((p) => p.id === "xingchi");
assert.equal(provider.features?.usage, true);
assert.equal(provider.features?.usageApikey, true);

const data = {
  isValid: true, mode: "unrestricted", planName: "钱包余额", unit: "USD",
  balance: 299.997651, remaining: 299.997651,
  usage: { today: { requests: 3, total_tokens: 2277, cost: 0.004698, actual_cost: 0.002349 } },
};
const billing = { object: "sub2api.key_billing", billing_scope: "token", effective_rate_multiplier: 1 };
const calls = [];
const mock = async (url, options) => {
  calls.push({ url, options });
  return new Response(JSON.stringify(url.endsWith("/usage") ? data : billing), { status: 200 });
};
const result = await getXingchiUsage("  TEST-ONLY-KEY ", null, mock);
assert.equal(calls.length, 2);
assert.equal(calls[0].options.headers.Authorization, "Bearer TEST-ONLY-KEY");
assert.equal(calls[1].options.headers.Authorization, "Bearer TEST-ONLY-KEY");
assert.equal(result.quotas["Balance (USD)"].total, 299.997651);
assert.equal(result.quotas["Balance (USD)"].isCreditBalance, true);
assert.equal(result.xingchi.today.actualCost, 0.002349);
assert.equal(result.xingchi.billingRate, 1);

const noBilling = await getXingchiUsage("TEST-ONLY-KEY", null, async (url) =>
  new Response(JSON.stringify(url.endsWith("/usage") ? data : {}), {
    status: url.endsWith("/usage") ? 200 : 404,
  }));
assert.equal(noBilling.xingchi.balance, 299.997651);
assert.equal(noBilling.xingchi.billingRate, null);

const subscription = normalizeXingchiUsage({
  planName: "Subscription", remaining: -1, unit: "USD",
  subscription: { daily_usage_usd: 2, daily_limit_usd: 10, weekly_usage_usd: 3, weekly_limit_usd: 20 },
});
assert.deepEqual(Object.keys(subscription.quotas), ["Daily subscription (USD)", "Weekly subscription (USD)"]);
assert.equal(subscription.xingchi.balance, null);

const keyQuota = normalizeXingchiUsage({
  remaining: 70, unit: "USD", quota: { used: 30, limit: 100, remaining: 70 },
});
assert.equal(keyQuota.quotas["API Key quota (USD)"].total, 100);
assert.equal("remaining" in keyQuota.quotas["API Key quota (USD)"], false);

const rate = normalizeXingchiUsage({
  rate_limits: [{ window: "5h", used: 3, limit: 10, reset_at: "2026-11-21T00:00:00Z" }],
});
assert.equal(rate.quotas["Rate limit (5h)"].resetAt, "2026-11-21T00:00:00.000Z");

const ui = readFileSync(fileURLToPath(new URL("../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js", import.meta.url)), "utf8");
assert.match(ui, /<XingchiUsageDetails details=\{quota\?\.raw\?\.xingchi\}/);
const parser = readFileSync(fileURLToPath(new URL("../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js", import.meta.url)), "utf8");
assert.match(parser, /case "xingchi":/);

console.log("PASS: Xingchi quota flags, authenticated endpoints, wallet, billing fallback, subscription, key quota, rate-limit, dashboard wiring");
