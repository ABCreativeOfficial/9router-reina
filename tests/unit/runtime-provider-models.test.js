import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildRuntimeProviderCatalog,
  catalogModelsForCli,
  fetchRuntimeProviderModels,
} from "@/shared/utils/runtimeProviderModels";
import { getModelsByProviderId } from "@/shared/constants/models";

const PROVIDER_ID = "openai-compatible-chat-runtime";
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const SELECTOR = read("../../src/shared/components/ModelSelectModal.js");
const CLI = read("../../src/app/(dashboard)/dashboard/cli-tools/[toolId]/ToolDetailClient.js");
const newApiConnection = (id, enabledModels, isActive = true) => ({
  id,
  provider: PROVIDER_ID,
  name: `Account ${id}`,
  isActive,
  providerSpecificData: {
    newApiOrigin: "https://example.com",
    newApiLabel: "Runtime API",
    prefix: "rt",
    ...(enabledModels ? { enabledModels } : {}),
  },
});

describe("runtime provider model catalog", () => {
  it("wires CLI Tools and Combo selection to the same runtime source", () => {
    for (const source of [CLI, SELECTOR]) {
      expect(source).toContain("fetchRuntimeProviderModels");
      expect(source).toContain("buildRuntimeProviderCatalog");
    }
    expect(CLI).not.toContain('fallbackModels.push({ id: "model-id"');
    expect(SELECTOR).toContain("runtimeProvider?.isRuntime === true");
  });

  it("loads one server-owned runtime catalog without prior provider-page state", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        providers: {
          [PROVIDER_ID]: [
            { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
            { id: "gpt-5.2", name: "GPT 5.2" },
          ],
        },
      }),
    }));

    const runtimeModels = await fetchRuntimeProviderModels([
      newApiConnection("A", ["claude-sonnet-4-5"]),
      newApiConnection("B", ["gpt-5.2"]),
    ], fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toContain("/api/models/runtime?provider=");
    expect(runtimeModels[PROVIDER_ID].map((model) => model.id)).toEqual([
      "claude-sonnet-4-5",
      "gpt-5.2",
    ]);
  });

  it("feeds real alias-prefixed models to CLI Tools", () => {
    const catalog = buildRuntimeProviderCatalog({
      connections: [newApiConnection("A")],
      runtimeModels: { [PROVIDER_ID]: [{ id: "gpt-5.2", name: "GPT 5.2" }] },
    });

    expect(catalogModelsForCli(catalog)).toEqual([
      expect.objectContaining({ value: "rt/gpt-5.2", label: "rt/gpt-5.2", provider: PROVIDER_ID }),
    ]);
    expect(catalogModelsForCli(catalog).some((model) => model.value.endsWith("/model-id"))).toBe(false);
  });

  it("feeds the same alias-prefixed runtime models to the combo selector", () => {
    const catalog = buildRuntimeProviderCatalog({
      connections: [newApiConnection("A")],
      runtimeModels: { [PROVIDER_ID]: [{ id: "gemini-2.5-pro" }] },
    });
    const provider = catalog[PROVIDER_ID];

    expect(provider.name).toBe("Runtime API");
    expect(provider.alias).toBe("rt");
    expect(provider.models.map((model) => `${provider.alias}/${model.id}`)).toEqual([
      "rt/gemini-2.5-pro",
    ]);
  });

  it("leaves static provider catalogs unchanged", () => {
    const connection = {
      id: "static",
      provider: "claude",
      isActive: true,
      name: "Claude",
      providerSpecificData: { prefix: "stale-prefix" },
    };
    const catalog = buildRuntimeProviderCatalog({ connections: [connection] });

    expect(catalog.claude.isRuntime).toBe(false);
    expect(catalog.claude.alias).toBe("cc");
    expect(catalog.claude.models).toEqual(getModelsByProviderId("claude"));
  });

  it("preserves plain compatible-provider fallbacks without inventing one for New API", () => {
    const provider = "openai-compatible-chat-plain";
    const plain = {
      id: "plain",
      provider,
      isActive: true,
      testStatus: "active",
      providerSpecificData: { prefix: "plain" },
    };
    const plainCatalog = buildRuntimeProviderCatalog({ connections: [plain] });
    const runtimeCatalog = buildRuntimeProviderCatalog({ connections: [newApiConnection("A")] });

    expect(plainCatalog[provider].models.map((model) => model.id)).toEqual(["model-id"]);
    expect(runtimeCatalog[PROVIDER_ID].models).toEqual([]);
  });

  it("ignores inactive runtime accounts", async () => {
    const fetchFn = vi.fn();
    expect(await fetchRuntimeProviderModels([newApiConnection("A", null, false)], fetchFn)).toEqual({});
    expect(buildRuntimeProviderCatalog({ connections: [newApiConnection("A", null, false)] })).toEqual({});
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
