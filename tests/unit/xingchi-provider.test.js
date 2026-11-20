import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { parseModel } from "../../open-sse/services/model.js";
import { getTargetFormat } from "../../open-sse/services/provider.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { CODEX_CLI_VERSION } from "../../open-sse/config/codexModels.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { parseXingchiCatalog, resolveXingchiModels, clearXingchiCatalogCacheForTests } from "../../open-sse/services/xingchiModels.js";
import { getProviderIconSrc } from "../../src/shared/utils/providerIcon.js";
import { getProviderCustomModelRows } from "../../src/shared/utils/providerCustomModels.js";
import { mergeXingchiModelCatalog } from "../../src/shared/utils/xingchiModelCatalog.js";

describe("Xingchi API-key Responses provider", () => {
  it("is registered as an API-key provider with streaming Responses transport", () => {
    const entry = REGISTRY.find((item) => item.id === "xingchi");
    expect(entry).toMatchObject({
      alias: "xc",
      category: "apikey",
      authType: "apikey",
      passthroughModels: true,
    });
    expect(PROVIDERS.xingchi).toMatchObject({
      baseUrl: "https://api.xingchiapi.com/v1/responses",
      validateUrl: "https://api.xingchiapi.com/v1/models",
      format: "openai-responses",
      forceStream: true,
      headers: { "x-openai-actor-authorization": "local-image-extension" },
      quirks: { disableResponseStorage: true },
    });
    expect(PROVIDERS.xingchi.headers?.originator).toBe("codex_cli_rs");
    expect(getTargetFormat("xingchi")).toBe("openai-responses");
  });

  it("resolves the short alias without rewriting upstream model ids", () => {
    expect(parseModel("xc/gpt-6.1-sol")).toMatchObject({
      provider: "xingchi",
      model: "gpt-6.1-sol",
    });
    expect(PROVIDER_MODELS.xc).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gpt-6.1-sol" }),
    ]));
  });

  it("sends only standard API-key headers to the streaming Responses endpoint", () => {
    const executor = new DefaultExecutor("xingchi");
    expect(executor.buildUrl("gpt-6.1-sol", true)).toBe("https://api.xingchiapi.com/v1/responses");
    const headers = executor.buildHeaders({ apiKey: "test-key" }, true);
    expect(headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
      Accept: "text/event-stream",
      "x-openai-actor-authorization": "local-image-extension",
    });
    expect(headers.originator).toBe("codex_cli_rs");
    expect(headers["User-Agent"]).toBe(`codex_cli_rs/${CODEX_CLI_VERSION}`);
    expect(headers.version).toBe(CODEX_CLI_VERSION);
  });

  it("enforces stateless Responses without mutating the incoming request", () => {
    const executor = new DefaultExecutor("xingchi");
    const body = { model: "gpt-6.1-sol", input: "hello", store: true, stream: true };
    const transformed = executor.transformRequest("gpt-6.1-sol", body, true, { apiKey: "test-key" });
    expect(transformed.store).toBe(false);
    expect(body.store).toBe(true);
    const other = new DefaultExecutor("openai");
    expect(other.transformRequest("gpt-5.5", { ...body }, true, { apiKey: "test-key" }).store).toBe(true);
  });

  it("starts with all 16 curated models and their exact context, output and effort limits", () => {
    const entries = REGISTRY.find((entry) => entry.id === "xingchi").models;
    expect(entries).toHaveLength(16);
    expect(entries.find((entry) => entry.id === "gpt-6-astra")).toMatchObject({
      contextWindow: 1050000,
      maxOutput: 128000,
      reasoning: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(getThinkingLevels("xingchi", "gpt-5.3-codex-spark")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(getThinkingLevels("xingchi", "gpt-6.1-terra")).toContain("none");
    expect(getProviderIconSrc("xingchi")).toBe("/providers/xingchi.svg");
  });

  it("normalizes both OpenAI /v1/models id records and Codex-native slug records", () => {
    expect(parseXingchiCatalog({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6.1-sol" }] }))
      .toEqual([{ id: "gpt-6.1-sol", name: "gpt-6.1-sol" }]);
    expect(parseXingchiCatalog({ models: [
      { slug: "gpt-6-astra", display_name: "Astra", context_window: 1050000 },
      { slug: "hidden-model", visibility: "hide" },
      { slug: "bad id" },
    ] })).toEqual([{ id: "gpt-6-astra", name: "Astra", contextWindow: 1050000 }]);
    expect(parseXingchiCatalog({ models: { "gpt-5.6-sol": { name: "Sol" } } }))
      .toEqual([{ id: "gpt-5.6-sol", name: "Sol" }]);
  });

  it("fetches models with the Codex catalog headers, caches success, and retains it on errors", async () => {
    clearXingchiCatalogCacheForTests();
    const calls = [];
    let fail = false;
    const fetchFn = async (url, options) => {
      calls.push({ url, options });
      return fail
        ? { ok: false, status: 403 }
        : { ok: true, json: async () => ({ models: [{ slug: "new-xingchi-model", display_name: "New" }] }) };
    };
    const connection = { apiKey: "fake-test-key" };
    const first = await resolveXingchiModels(connection, { fetchFn });
    expect(first.models).toEqual([{ id: "new-xingchi-model", name: "New" }]);
    expect(calls[0].url).toContain(`client_version=${CODEX_CLI_VERSION}`);
    expect(calls[0].options.headers).toMatchObject({
      Authorization: "Bearer fake-test-key",
      originator: "codex_cli_rs",
      "x-openai-actor-authorization": "local-image-extension",
    });
    await resolveXingchiModels(connection, { fetchFn });
    expect(calls).toHaveLength(1);
    fail = true;
    const stale = await resolveXingchiModels(connection, { fetchFn, forceRefresh: true });
    expect(stale.models).toEqual(first.models);
    expect(stale.warning).toContain("HTTP 403");
    expect(calls).toHaveLength(2);
    clearXingchiCatalogCacheForTests();
  });

  it("never empties the seed models when discovery is unavailable; keeps manual models on reload", async () => {
    clearXingchiCatalogCacheForTests();
    const fallback = await resolveXingchiModels({ apiKey: "another-fake-key" }, {
      fetchFn: async () => ({ ok: true, json: async () => ({ data: [] }) }),
    });
    expect(fallback.models).toHaveLength(16);
    expect(fallback.warning).toContain("no usable model IDs");
    const live = [{ id: "gpt-6.1-sol", name: "Sol from upstream" }, { id: "upstream-new", name: "Upstream New" }];
    const combined = mergeXingchiModelCatalog(fallback.models, live);
    expect(combined).toHaveLength(17);
    expect(combined.find((m) => m.id === "gpt-6.1-sol").name).toBe("GPT-6.1 Sol");
    const storedModels = [{ providerAlias: "xc", id: "user-added", name: "User Added", type: "llm" }];
    const customRows = getProviderCustomModelRows({
      customModels: storedModels,
      providerAlias: "xc",
      builtInModels: combined,
    });
    expect(customRows).toMatchObject([{ id: "user-added", fullModel: "xc/user-added", source: "custom" }]);
    clearXingchiCatalogCacheForTests();
  });
});
