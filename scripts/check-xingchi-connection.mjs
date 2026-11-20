/** Offline regression check for Xingchi connection probing and bulk-add. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { probeXingchiApiKey } from "../open-sse/services/xingchiValidation.js";
import { planBulkAdd } from "../src/shared/utils/bulkAdd.js";

const fakeResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const calls = [];
const result = await probeXingchiApiKey(" TEST-ONLY-KEY ", {
  fetchFn: async (url, options) => {
    calls.push([url, options]);
    return fakeResponse({ isValid: true, balance: 299 });
  },
});
assert.deepEqual(result, { valid: true, error: null });
assert.equal(calls.length, 1);
assert.match(calls[0][0], /\/v1\/usage$/);
assert.equal(calls[0][1].headers.Authorization, "Bearer TEST-ONLY-KEY");

const failed = await probeXingchiApiKey("TEST-ONLY-KEY", {
  fetchFn: async () => fakeResponse({ isValid: false }),
});
assert.equal(failed.valid, false);

const fallback = await probeXingchiApiKey("TEST-ONLY-KEY", {
  fetchFn: async (url) => url.includes("/usage")
    ? fakeResponse({}, 404)
    : fakeResponse({ data: [{ id: "gpt-6.1-sol" }] }),
});
assert.equal(fallback.valid, true);

const names = planBulkAdd(["sk-first", "", "sk-second", "sk-first"],
  ["Xingchi Key 1"], { defaultBaseName: "Xingchi Key", dedupeKeys: true });
assert.deepEqual(names.map(({ name }) => name), ["Xingchi Key 2", "Xingchi Key 3"]);

const testUtils = readFileSync(new URL("../src/app/api/providers/[id]/test/testUtils.js", import.meta.url), "utf8");
const validation = readFileSync(new URL("../src/app/api/providers/validate/route.js", import.meta.url), "utf8");
const modal = readFileSync(new URL("../src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js", import.meta.url), "utf8");
assert.match(testUtils, /case "xingchi":\s*return probeXingchiApiKey/);
assert.match(validation, /case "xingchi":\s*\{[\s\S]*?probeXingchiApiKey\(apiKey\)/);
assert.match(modal, /defaultBaseName: "Xingchi Key", dedupeKeys: true/);
assert.doesNotMatch(modal, /mode === "bulk" && !isXingchi/);

console.log("PASS: Xingchi initial validation, one-by-one handler, auth rejection, catalog fallback, newline bulk, unique naming");
