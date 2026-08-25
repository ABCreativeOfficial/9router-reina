import { describe, it, expect } from "vitest";
import { buildProviderModelCatalog } from "@/shared/utils/providerModelCatalog";

const m = (id, extra = {}) => ({ id, name: `${id} name`, ...extra });

describe("buildProviderModelCatalog", () => {
  it("uses the registry by default and the live catalog only when asked", () => {
    const args = { staticModels: [m("s1")], liveModels: [m("l1")], providerStorageAlias: "cc" };
    expect(buildProviderModelCatalog(args).builtInModels.map((x) => x.id)).toEqual(["s1"]);
    expect(
      buildProviderModelCatalog({ ...args, preferLiveModels: true }).builtInModels.map((x) => x.id)
    ).toEqual(["l1"]);
  });

  it("falls back to the registry when the live catalog is empty", () => {
    const catalog = buildProviderModelCatalog({
      staticModels: [m("s1")],
      liveModels: [],
      preferLiveModels: true,
      providerStorageAlias: "cc",
    });
    expect(catalog.builtInModels.map((x) => x.id)).toEqual(["s1"]);
  });

  it("merges kilo free models and drops duplicates", () => {
    const catalog = buildProviderModelCatalog({
      staticModels: [m("a")],
      kiloFreeModels: [m("a"), m("free1")],
      providerStorageAlias: "kc",
    });
    expect(catalog.displayModels.map((x) => x.id)).toEqual(["a", "free1"]);
  });

  it("excludes non-LLM kinds, which have their own media-provider pages", () => {
    const catalog = buildProviderModelCatalog({
      staticModels: [m("chat"), m("embed", { type: "embedding" }), m("voice", { type: "tts" })],
      providerStorageAlias: "cc",
    });
    expect(catalog.displayModels.map((x) => x.id)).toEqual(["chat"]);
  });

  it("splits globally disabled models out of displayModels but keeps them listed", () => {
    const catalog = buildProviderModelCatalog({
      staticModels: [m("a"), m("b")],
      disabledModelIds: ["b"],
      providerStorageAlias: "cc",
    });
    expect(catalog.displayModels.map((x) => x.id)).toEqual(["a"]);
    expect(catalog.disabledModels.map((x) => x.id)).toEqual(["b"]);
    // entries carries both, flagged — the Model Access modal shows the flag rather than hiding.
    expect(catalog.entries.map((e) => [e.id, e.disabled])).toEqual([["a", false], ["b", true]]);
  });

  it("includes custom models and legacy aliases for the matching alias only", () => {
    const catalog = buildProviderModelCatalog({
      staticModels: [m("builtin")],
      customModels: [
        { id: "mine", name: "Mine", providerAlias: "cc", type: "llm" },
        { id: "other", name: "Other", providerAlias: "cx", type: "llm" },
      ],
      modelAliases: { fast: "cc/aliased", nope: "cx/elsewhere" },
      providerStorageAlias: "cc",
    });
    const ids = catalog.entries.map((e) => e.id);
    expect(ids).toContain("mine");
    expect(ids).toContain("aliased");
    expect(ids).not.toContain("other");
    expect(ids).not.toContain("elsewhere");
    expect(ids).toContain("builtin");
  });

  it("orders custom entries before built-ins and dedupes by id", () => {
    const catalog = buildProviderModelCatalog({
      staticModels: [m("shared"), m("b")],
      customModels: [{ id: "custom", providerAlias: "cc", type: "llm" }],
      providerStorageAlias: "cc",
    });
    expect(catalog.entries.map((e) => e.id)).toEqual(["custom", "shared", "b"]);
    expect(new Set(catalog.entries.map((e) => e.id)).size).toBe(catalog.entries.length);
  });

  it("tags each entry with its source", () => {
    const catalog = buildProviderModelCatalog({
      staticModels: [m("builtin")],
      customModels: [{ id: "mine", providerAlias: "cc", type: "llm" }],
      modelAliases: { fast: "cc/aliased" },
      providerStorageAlias: "cc",
    });
    const byId = Object.fromEntries(catalog.entries.map((e) => [e.id, e.source]));
    expect(byId).toEqual({ mine: "custom", aliased: "legacyAlias", builtin: "builtIn" });
  });

  it("returns empty collections for a provider with nothing configured", () => {
    const catalog = buildProviderModelCatalog({ providerStorageAlias: "cc" });
    expect(catalog.displayModels).toEqual([]);
    expect(catalog.disabledModels).toEqual([]);
    expect(catalog.entries).toEqual([]);
  });
});
