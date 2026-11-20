import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CODEX_CLI_VERSION } from "../../open-sse/config/codexModels.js";
import { probeXingchiApiKey } from "../../open-sse/services/xingchiValidation.js";
import { planBulkAdd } from "../../src/shared/utils/bulkAdd.js";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { testSingleConnection } from "../../src/app/api/providers/[id]/test/testUtils.js";
import { POST as validatePost } from "../../src/app/api/providers/validate/route.js";

const VALID_USAGE = { isValid: true, mode: "unrestricted", balance: 299.9 };
const TEST_KEY = "TEST-XINGCHI-KEY";

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Xingchi authenticated read-only connection probe", () => {
  it("accepts a valid key from /v1/usage without inference or catalog calls", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(VALID_USAGE));
    const result = await probeXingchiApiKey(` ${TEST_KEY} `, { fetchFn });
    expect(result).toEqual({ valid: true, error: null });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, options] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.xingchiapi.com/v1/usage");
    expect(options).toMatchObject({ method: "GET", cache: "no-store" });
    expect(options.headers).toMatchObject({
      Authorization: `Bearer ${TEST_KEY}`,
      "x-openai-actor-authorization": "local-image-extension",
      originator: "codex_cli_rs",
    });
    expect(options.body).toBeUndefined();
  });

  it.each([401, 403])("rejects authentication HTTP %d without falling back to a possibly public catalog", async (status) => {
    const fetchFn = vi.fn().mockResolvedValue(response({}, status));
    const result = await probeXingchiApiKey(TEST_KEY, { fetchFn });
    expect(result).toMatchObject({ valid: false });
    expect(result.error).toContain(String(status));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects a 200 body that explicitly declares an invalid key", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({ isValid: false }));
    expect(await probeXingchiApiKey(TEST_KEY, { fetchFn })).toMatchObject({ valid: false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("falls back to the Codex-style catalog when the usage endpoint is unavailable", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response({ models: [{ slug: "gpt-6.1-sol" }] }));
    const result = await probeXingchiApiKey(TEST_KEY, { fetchFn });
    expect(result).toEqual({ valid: true, error: null });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1][0]).toContain(`/v1/models?client_version=${CODEX_CLI_VERSION}`);
  });

  it("does not treat an arbitrary HTTP 200 model response as authenticated success", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(response({}, 500))
      .mockResolvedValueOnce(response({}));
    const result = await probeXingchiApiKey(TEST_KEY, { fetchFn });
    expect(result).toMatchObject({ valid: false, inconclusive: true });
  });

  it("handles network failures and missing keys without leaking credentials", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error(`forbidden ${TEST_KEY}`));
    const result = await probeXingchiApiKey(TEST_KEY, { fetchFn });
    expect(result).toMatchObject({ valid: false, inconclusive: true });
    expect(JSON.stringify(result)).not.toContain(TEST_KEY);
    expect(await probeXingchiApiKey(" ", { fetchFn })).toMatchObject({ valid: false });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("Xingchi Add Key and Test Connection One-by-One", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderConnectionById.mockResolvedValue({
      id: "saved-xc-1",
      provider: "xingchi",
      authType: "apikey",
      apiKey: TEST_KEY,
      providerSpecificData: {},
    });
    updateProviderConnection.mockResolvedValue({});
  });

  afterEach(() => vi.unstubAllGlobals());

  it("marks a saved valid connection active instead of 'Provider test not supported'", async () => {
    const upstream = vi.fn().mockResolvedValue(response(VALID_USAGE));
    vi.stubGlobal("fetch", upstream);
    const result = await testSingleConnection("saved-xc-1");
    expect(result).toMatchObject({ valid: true, error: null });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(updateProviderConnection).toHaveBeenCalledWith("saved-xc-1", expect.objectContaining({
      testStatus: "active", lastError: null,
    }));
  });

  it("marks an explicitly denied saved key as error with a useful message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 401)));
    const result = await testSingleConnection("saved-xc-1");
    expect(result).toMatchObject({ valid: false });
    expect(result.error).toContain("401");
    expect(updateProviderConnection).toHaveBeenCalledWith("saved-xc-1", expect.objectContaining({ testStatus: "error" }));
  });

  it("returns active from the initial Add Key validation endpoint", async () => {
    proxyAwareFetch.mockResolvedValue(response(VALID_USAGE));
    const req = new Request("http://localhost/api/providers/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "xingchi", apiKey: TEST_KEY }),
    });
    const res = await validatePost(req);
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ valid: true, error: null });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("plans newline-separated Xingchi keys with unique gap-filled names", () => {
    const planned = planBulkAdd([
      "sk-one\r", "  ", "sk-two", "sk-one", "sk-three",
    ], ["Xingchi Key 1", "xingchi KEY 3"], {
      defaultBaseName: "Xingchi Key", dedupeKeys: true,
    });
    expect(planned.map(({ name, apiKey }) => ({ name, apiKey }))).toEqual([
      { name: "Xingchi Key 4", apiKey: "sk-one" },
      { name: "Xingchi Key 5", apiKey: "sk-two" },
      { name: "Xingchi Key 6", apiKey: "sk-three" },
    ]);
  });

  it("exposes bulk mode for Xingchi and preserves the regular single-add form", () => {
    const source = readFileSync(new URL("../../src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js", import.meta.url), "utf8");
    expect(source).toContain('defaultBaseName: "Xingchi Key", dedupeKeys: true');
    expect(source).toContain('mode === "bulk" &&');
    expect(source).toContain('mode === "single" &&');
    expect(source).not.toContain('mode === "bulk" && !isXingchi');
  });
});
