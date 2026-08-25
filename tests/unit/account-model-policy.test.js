import { describe, expect, it } from "vitest";
import {
  sanitizeEnabledModels,
  getEnabledModels,
  hasModelRestriction,
  isConnectionEligibleForModel,
  collectProviderModelVisibility,
  splitModelLevel,
  MAX_ENABLED_MODELS,
} from "@/sse/services/accountModelPolicy.js";

const conn = (enabledModels, extra = {}) => ({
  id: extra.id || "c1",
  provider: extra.provider || "codex",
  ...extra,
  providerSpecificData: {
    ...(extra.providerSpecificData || {}),
    ...(enabledModels === undefined ? {} : { enabledModels }),
  },
});

describe("sanitizeEnabledModels", () => {
  it("keeps only trimmed, unique, non-empty strings", () => {
    expect(sanitizeEnabledModels([" a ", "a", "", "  ", 3, null, "b"])).toEqual(["a", "b"]);
  });

  it("drops level suffixes and dedupes to the base model", () => {
    expect(sanitizeEnabledModels(["m(low)", "m", "m(xhigh)", "n(high)"])).toEqual(["m", "n"]);
  });

  it("returns [] for non-arrays", () => {
    for (const bad of [undefined, null, "a", 1, {}]) expect(sanitizeEnabledModels(bad)).toEqual([]);
  });

  it("caps runaway payloads", () => {
    const big = Array.from({ length: MAX_ENABLED_MODELS + 50 }, (_, i) => `m${i}`);
    expect(sanitizeEnabledModels(big)).toHaveLength(MAX_ENABLED_MODELS);
  });
});

describe("policy presence", () => {
  it("treats missing/empty/invalid as unrestricted", () => {
    for (const v of [undefined, [], null, "gpt-5", [""], [123]]) {
      expect(hasModelRestriction(conn(v))).toBe(false);
      expect(getEnabledModels(conn(v))).toEqual([]);
    }
  });

  it("treats a non-empty list as restricted", () => {
    expect(hasModelRestriction(conn(["gpt-5.5"]))).toBe(true);
  });
});

describe("isConnectionEligibleForModel", () => {
  it("legacy connection with no policy is eligible for anything", () => {
    expect(isConnectionEligibleForModel(conn(undefined), "sol")).toBe(true);
    expect(isConnectionEligibleForModel({}, "sol")).toBe(true);
    expect(isConnectionEligibleForModel(undefined, "sol")).toBe(true);
  });

  it("allows an allowlisted model and skips one that is absent", () => {
    const c = conn(["gpt-5.5", "sol"]);
    expect(isConnectionEligibleForModel(c, "sol")).toBe(true);
    expect(isConnectionEligibleForModel(c, "gpt-5.5")).toBe(true);
    expect(isConnectionEligibleForModel(c, "gpt-5.5-codex")).toBe(false);
  });

  it("matches exactly — no substring or case-insensitive fuzz", () => {
    const c = conn(["gpt-5.5"]);
    expect(isConnectionEligibleForModel(c, "gpt-5")).toBe(false);
    expect(isConnectionEligibleForModel(c, "gpt-5.5-high")).toBe(false);
    expect(isConnectionEligibleForModel(c, "GPT-5.5")).toBe(false);
  });

  it("normalizes provider prefixes on both sides", () => {
    // Entry copied from /v1/models ("codex/sol") still matches the bare router model id.
    expect(isConnectionEligibleForModel(conn(["codex/sol"]), "sol")).toBe(true);
    expect(isConnectionEligibleForModel(conn(["sol"]), "codex/sol")).toBe(true);
    // Custom prefix configured on the connection.
    const withPrefix = conn(["mine/sol"], { providerSpecificData: { prefix: "mine" } });
    expect(isConnectionEligibleForModel(withPrefix, "sol")).toBe(true);
    // An unrelated prefix is not stripped, so it does not match.
    expect(isConnectionEligibleForModel(conn(["other/sol"]), "sol")).toBe(false);
  });

  it("keeps model-less lookups (web search/fetch) unchanged", () => {
    expect(isConnectionEligibleForModel(conn(["sol"]), null)).toBe(true);
    expect(isConnectionEligibleForModel(conn(["sol"]), undefined)).toBe(true);
  });

  it("handles custom ids that themselves contain slashes", () => {
    const c = conn(["org/llama-3.3"], { provider: "openai-compatible" });
    expect(isConnectionEligibleForModel(c, "org/llama-3.3")).toBe(true);
  });

  it("4 capable + 2 restricted accounts: only the capable ones survive", () => {
    const pool = [
      conn(["a", "b", "sol"], { id: "A" }),
      conn(["a", "b", "sol"], { id: "B" }),
      conn(["a", "b", "sol"], { id: "C" }),
      conn(["a", "b", "sol"], { id: "D" }),
      conn(["a", "b"], { id: "E" }),
      conn(["b"], { id: "F" }),
    ];
    expect(pool.filter((c) => isConnectionEligibleForModel(c, "sol")).map((c) => c.id))
      .toEqual(["A", "B", "C", "D"]);
    // A model enabled everywhere keeps the whole pool.
    expect(pool.filter((c) => isConnectionEligibleForModel(c, "b"))).toHaveLength(6);
    expect(pool.filter((c) => isConnectionEligibleForModel(c, "a")).map((c) => c.id))
      .toEqual(["A", "B", "C", "D", "E"]);
  });
});

describe("splitModelLevel", () => {
  it("splits a level suffix and lowercases it", () => {
    expect(splitModelLevel("gpt-5.6-luna(xhigh)")).toEqual({ base: "gpt-5.6-luna", level: "xhigh" });
    expect(splitModelLevel(" gpt-5.6-luna ( XHigh ) ")).toEqual({ base: "gpt-5.6-luna", level: "xhigh" });
  });

  it("returns a null level when no suffix is present", () => {
    expect(splitModelLevel("gpt-5.6-luna")).toEqual({ base: "gpt-5.6-luna", level: null });
    expect(splitModelLevel(undefined)).toEqual({ base: "", level: null });
  });

  it("leaves an id whose parens are not a trailing suffix alone", () => {
    expect(splitModelLevel("weird(a)b")).toEqual({ base: "weird(a)b", level: null });
  });
});

describe("isConnectionEligibleForModel — level suffixes", () => {
  it("an entry grants its model at every thinking level", () => {
    const c = conn(["gpt-5.6-luna"]);
    expect(isConnectionEligibleForModel(c, "gpt-5.6-luna")).toBe(true);
    expect(isConnectionEligibleForModel(c, "gpt-5.6-luna(xhigh)")).toBe(true);
    expect(isConnectionEligibleForModel(c, "gpt-5.6-luna(low)")).toBe(true);
    // still a different model
    expect(isConnectionEligibleForModel(c, "gpt-5.6-sol(xhigh)")).toBe(false);
  });

  it("a legacy level-suffixed entry is normalized to its base model", () => {
    // Older builds could store m(level); it must not act as a hidden level restriction.
    const c = conn(["gpt-5.6-luna(low)"]);
    expect(isConnectionEligibleForModel(c, "gpt-5.6-luna")).toBe(true);
    expect(isConnectionEligibleForModel(c, "gpt-5.6-luna(low)")).toBe(true);
    expect(isConnectionEligibleForModel(c, "gpt-5.6-luna(xhigh)")).toBe(true);
    expect(isConnectionEligibleForModel(c, "gpt-5.6-sol")).toBe(false);
  });

  it("several level entries of one model collapse to a single grant", () => {
    expect(getEnabledModels(conn(["m(low)", "m(medium)", "m"]))).toEqual(["m"]);
  });

  it("normalizes level suffix and provider prefix together", () => {
    expect(isConnectionEligibleForModel(conn(["codex/gpt-5.6-luna(low)"]), "gpt-5.6-luna(xhigh)")).toBe(true);
    expect(isConnectionEligibleForModel(conn(["gpt-5.6-luna"]), "codex/gpt-5.6-luna(low)")).toBe(true);
    expect(isConnectionEligibleForModel(conn(["codex/gpt-5.6-luna"]), "gpt-5.6-luna(xhigh)")).toBe(true);
  });

  it("an unrestricted account ignores levels entirely", () => {
    expect(isConnectionEligibleForModel(conn(undefined), "gpt-5.6-luna(xhigh)")).toBe(true);
  });

  it("custom ids containing slashes keep working with a level suffix", () => {
    const c = conn(["org/llama-3.3"], { provider: "openai-compatible" });
    expect(isConnectionEligibleForModel(c, "org/llama-3.3(high)")).toBe(true);
    expect(isConnectionEligibleForModel(c, "org/llama-3.3(low)")).toBe(true);
    expect(isConnectionEligibleForModel(c, "org/llama-3.2(low)")).toBe(false);
  });
});

describe("collectProviderModelVisibility", () => {
  it("one unrestricted account keeps the full catalog visible", () => {
    const v = collectProviderModelVisibility([conn(["sol"]), conn(undefined)]);
    expect(v.allRestricted).toBe(false);
  });

  it("unions allowlists when every account is restricted", () => {
    const v = collectProviderModelVisibility([conn(["sol", "a"]), conn(["a", "b"])]);
    expect(v.allRestricted).toBe(true);
    expect(v.allowedUnion).toEqual(["sol", "a", "b"]);
  });

  it("drops level suffixes and dedupes to the base model id", () => {
    const v = collectProviderModelVisibility([conn(["m(low)", "m(high)"]), conn(["m", "n(xhigh)"])]);
    expect(v.allRestricted).toBe(true);
    expect(v.allowedUnion).toEqual(["m", "n"]);
  });

  it("no connections is not a restriction", () => {
    expect(collectProviderModelVisibility([]).allRestricted).toBe(false);
    expect(collectProviderModelVisibility(null).allRestricted).toBe(false);
  });
});
