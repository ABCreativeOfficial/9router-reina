// Offline regression check: no npm install and no Token Harbor API key needed.
// Run from repository root: node scripts/check-tokenharbor-quota.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import REGISTRY from "../open-sse/providers/registry/index.js";
import { getTokenHarborUsage, normalizeTokenHarborAllowance } from "../open-sse/services/usage/tokenharbor.js";

const entry = REGISTRY.find((provider) => provider.id === "tokenharbor");
assert.equal(entry.features?.usage, true);
assert.equal(entry.features?.usageApikey, true);
assert.equal(entry.transport.usage.url, "https://tokenharbor.ai/api/cli/free-tier");

const sample = {
  plan_name: null,
  models: ["deepseek-v4-flash", "mimo-v2.6-flash", "mimo-v2.5", "deepseek-v4.1-flash"],
  models_enabled: true, on_plan: false, req_used: 187,
  reset_at: "2026-11-22T18:05:52.654917+00:00",
  used_pct: 16, activated: true, exhausted: false,
};
const calls = [];
const fetcher = async (url, options) => {
  calls.push([url, options]);
  return new Response(JSON.stringify(sample), { status: 200 });
};
const data = await getTokenHarborUsage("  TEST-ONLY-KEY ", null, fetcher);
assert.equal(calls.length, 1);
assert.equal(calls[0][0], "https://tokenharbor.ai/api/cli/free-tier");
assert.equal(calls[0][1].headers.Authorization, "Bearer TEST-ONLY-KEY");
assert.equal(data.quotas["Free models (7d)"].remainingPercentage, 84);
assert.equal(data.quotas["Pass allowance (7d)"], undefined);
assert.equal(data.tokenharbor.requestsUsed, 187);
assert.deepEqual(data.tokenharbor.models, sample.models);
assert.equal(data.quotas["Free models (7d)"].resetAt, "2026-11-22T18:05:52.654Z");

const plan = normalizeTokenHarborAllowance({
  ...sample, on_plan: true, plan_name: "Office Pass", plan_used_pct: 37,
});
assert.equal(plan.quotas["Pass allowance (7d)"].remainingPercentage, 63);

const exhausted = normalizeTokenHarborAllowance({ ...sample, exhausted: true, used_pct: 99 });
assert.equal(exhausted.quotas["Free models (7d)"].remainingPercentage, 0);
const disabled = normalizeTokenHarborAllowance({ ...sample, models_enabled: false });
assert.equal(disabled.tokenharbor.freeModelsEnabled, false);
assert.equal(disabled.quotas["Free models (7d)"].remainingPercentage, 84);
const idle = normalizeTokenHarborAllowance({ ...sample, activated: false, reset_at: null, used_pct: 0 });
assert.equal(idle.quotas["Free models (7d)"].resetAt, null);

const ui = readFileSync(fileURLToPath(new URL("../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js", import.meta.url)), "utf8");
assert.match(ui, /<TokenHarborUsageDetails details=\{quota\?\.raw\?\.tokenharbor\}/);
const parser = readFileSync(fileURLToPath(new URL("../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js", import.meta.url)), "utf8");
assert.match(parser, /case "tokenharbor":/);
console.log("PASS: Token Harbor allowance endpoint, 84% remaining, Pass, reset, exhausted/disabled/idle states, dashboard wiring");
