// Run without npm dependencies: node scripts/check-xingchi-regressions.mjs
// No live Xingchi requests or user API keys are needed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getModelsByProviderId } from "../open-sse/config/providerModels.js";
import { CODEX_CLI_VERSION } from "../open-sse/config/codexModels.js";
import { getThinkingLevels } from "../open-sse/providers/thinkingLevels.js";
import { parseXingchiCatalog, resolveXingchiModels, clearXingchiCatalogCacheForTests } from "../open-sse/services/xingchiModels.js";
import { mergeXingchiModelCatalog } from "../src/shared/utils/xingchiModelCatalog.js";
import { getProviderIconSrc } from "../src/shared/utils/providerIcon.js";
import { getProviderCustomModelRows } from "../src/shared/utils/providerCustomModels.js";

const seeds = getModelsByProviderId("xingchi");
assert.equal(seeds.length, 16, "must have 16 offline model entries");
assert.equal(new Set(seeds.map((model) => model.id)).size, 16);
assert.deepEqual(getThinkingLevels("xingchi", "gpt-6-astra"), ["low", "medium", "high", "xhigh", "max"]);
assert.deepEqual(getThinkingLevels("xingchi", "codex-mini-latest"), ["low", "medium", "high"]);
assert.equal(getProviderIconSrc("xingchi"), "/providers/xingchi.svg");
const svg = readFileSync(fileURLToPath(new URL("../public/providers/xingchi.svg", import.meta.url)), "utf8");
assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
assert.match(svg, /s2a-brand/);

assert.deepEqual(parseXingchiCatalog({ data: [{ id: "one" }, { id: "one" }, { id: "bad id" }] }), [{ id: "one", name: "one" }]);
assert.deepEqual(parseXingchiCatalog({ models: [{ slug: "codex-native", display_name: "Codex Native" }] }), [{ id: "codex-native", name: "Codex Native" }]);
assert.deepEqual(parseXingchiCatalog({ models: { "from-map": { name: "From Map" } } }), [{ id: "from-map", name: "From Map" }]);

clearXingchiCatalogCacheForTests();
let requests = 0;
let broken = false;
const fakeFetch = async (url, options) => {
  requests++;
  assert.match(url, /^https:\/\/api\.xingchiapi\.com\/v1\/models\?client_version=/);
  assert.ok(url.includes(CODEX_CLI_VERSION));
  assert.equal(options.headers.Authorization, "Bearer TEST-ONLY-KEY");
  assert.equal(options.headers.originator, "codex_cli_rs");
  assert.equal(options.headers["x-openai-actor-authorization"], "local-image-extension");
  return broken
    ? { ok: false, status: 403 }
    : { ok: true, json: async () => ({ models: [{ slug: "live-new", display_name: "New live model" }] }) };
};
const connection = { apiKey: "TEST-ONLY-KEY" };
const live = await resolveXingchiModels(connection, { fetchFn: fakeFetch });
assert.equal(live.models[0].id, "live-new");
await resolveXingchiModels(connection, { fetchFn: fakeFetch });
assert.equal(requests, 1, "successful model discovery must be cached");
broken = true;
const stale = await resolveXingchiModels(connection, { fetchFn: fakeFetch, forceRefresh: true });
assert.deepEqual(stale.models, live.models, "a failed refresh must retain the last successful catalog");
assert.match(stale.warning, /HTTP 403/);

const merged = mergeXingchiModelCatalog(seeds, [...live.models, { id: "gpt-6-astra", name: "Upstream override" }]);
assert.equal(merged.length, 17, "a partial live catalog must not erase the 16 seeds");
assert.equal(merged.find((entry) => entry.id === "gpt-6-astra").name, "GPT-6 Astra");
const afterReload = getProviderCustomModelRows({
  providerAlias: "xc",
  builtInModels: merged,
  customModels: [{ providerAlias: "xc", id: "manually-added", name: "Custom", type: "llm" }],
});
assert.equal(afterReload[0].fullModel, "xc/manually-added", "saved manual entries remain part of the merged UI catalog");

clearXingchiCatalogCacheForTests();
const failed = await resolveXingchiModels({ apiKey: "ANOTHER-TEST-KEY" }, {
  fetchFn: async () => ({ ok: true, json: async () => ({ data: [] }) }),
});
assert.equal(failed.models.length, 16, "empty live result must preserve the static fallback");
assert.ok(failed.warning);
console.log("PASS: SVG, 16 seeds, reasoning limits, Codex catalog headers, parsing, caching, fallback, manual-model merge");
