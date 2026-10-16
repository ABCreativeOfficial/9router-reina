import { describe, expect, it } from "vitest";
import {
  splitModelLevel,
  sanitizeEnabledModels,
  stripBracketSuffix,
} from "@/sse/services/accountModelPolicy.js";
import {
  stripThinkingSuffix,
  parseSuffix,
} from "../../open-sse/translator/concerns/thinkingUnified.js";
import {
  isReasoningLevelSuffix,
  stripReasoningLevelSuffix,
} from "../../open-sse/translator/concerns/thinking.js";
import { getProviderModels } from "../../open-sse/config/providerModels.js";
import { listCodexPublicModelIds, codexIdEncodesEffortOrTier } from "../../open-sse/config/codexModels.js";

/**
 * A Codex virtual alias ends in a `(…)` marker that is a SERVICE TIER, not a
 * thinking level. Four normalizers used to treat any trailing `(…)` as a level
 * and strip it, which truncated the alias into a dangling separator:
 *
 *   gpt-6-sol-(fast)      → gpt-6-sol-      (stored in enabledModels)
 *   gpt-6-sol-low-(fast)  → gpt-6-sol-low-
 *
 * `gpt-6-sol-` matches no model, so a restricted account silently became
 * ineligible for everything. These lock the vocabulary check that prevents it,
 * across every normalizer the list, combo picker and per-account picker use.
 */

/** The Codex virtual aliases: ids whose trailing marker is a tier, not a level. */
const ALIAS_IDS = listCodexPublicModelIds().filter((id) => codexIdEncodesEffortOrTier(id, "codex"));

/** Every normalizer that consumes a model id, as name → transform. */
const NORMALIZERS = {
  stripReasoningLevelSuffix: (id) => stripReasoningLevelSuffix(id),
  stripThinkingSuffix: (id) => stripThinkingSuffix(id),
  parseSuffix_cleanModel: (id) => parseSuffix(id).cleanModel,
  splitModelLevel_base: (id) => splitModelLevel(id).base,
  sanitizeEnabledModels_first: (id) => sanitizeEnabledModels([id])[0],
};

describe("Codex alias ids survive every normalizer intact", () => {
  it("covers both alias shapes", () => {
    expect(ALIAS_IDS.length).toBeGreaterThan(0);
    expect(ALIAS_IDS).toContain("gpt-6-sol-(fast)");
    expect(ALIAS_IDS).toContain("gpt-6-sol-low-(fast)");
    expect(ALIAS_IDS).toContain("gpt-6-sol-low");
  });

  it.each(Object.entries(NORMALIZERS))("%s leaves an alias unchanged", (_name, fn) => {
    for (const id of ALIAS_IDS) {
      expect(fn(id), id).toBe(id);
    }
  });

  it("never leaves a dangling separator on any registered Codex id", () => {
    for (const id of getProviderModels("cx").map((model) => model.id)) {
      for (const [name, fn] of Object.entries(NORMALIZERS)) {
        const out = fn(id);
        expect(String(out).endsWith("-"), `${name}(${id}) → ${out}`).toBe(false);
      }
    }
  });

  it("keeps the alias routable as a stored allowlist entry", () => {
    // The stored form is what the policy reads back on the next request.
    expect(sanitizeEnabledModels(["gpt-6-sol-(fast)"])).toEqual(["gpt-6-sol-(fast)"]);
    expect(sanitizeEnabledModels(["gpt-6-sol-low-(fast)"])).toEqual(["gpt-6-sol-low-(fast)"]);
  });
});

describe("a real level suffix is still stripped", () => {
  it("drops the level and keeps the model", () => {
    expect(stripReasoningLevelSuffix("gpt-6-sol(high)")).toBe("gpt-6-sol");
    expect(stripThinkingSuffix("gpt-6-sol(high)")).toBe("gpt-6-sol");
    expect(parseSuffix("gpt-6-sol(high)").cleanModel).toBe("gpt-6-sol");
    expect(splitModelLevel("gpt-6-sol(high)")).toEqual({ base: "gpt-6-sol", level: "high" });
    expect(sanitizeEnabledModels(["gpt-6-sol(high)"])).toEqual(["gpt-6-sol"]);
  });

  it("strips a level from an alias without corrupting the alias", () => {
    // `gpt-6-sol-low(high)` states the effort twice: the level goes, the alias stays.
    expect(stripReasoningLevelSuffix("gpt-6-sol-low(high)")).toBe("gpt-6-sol-low");
    expect(sanitizeEnabledModels(["gpt-6-sol-low(high)"])).toEqual(["gpt-6-sol-low"]);
  });

  it("still parses the budget and directive forms", () => {
    expect(parseSuffix("model(8192)")).toEqual({ cleanModel: "model", override: { mode: "budget", budget: 8192 } });
    expect(parseSuffix("m(auto)").override).toEqual({ mode: "auto" });
    expect(parseSuffix("m(none)").override).toEqual({ mode: "none" });
    expect(parseSuffix("gpt-5.6-sol(ultra)").override).toEqual({ mode: "level", level: "ultra" });
  });

  it("recognises level names and numeric budgets only", () => {
    for (const level of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "auto", "off", "8192", " HIGH "]) {
      expect(isReasoningLevelSuffix(level), level).toBe(true);
    }
    for (const notLevel of ["fast", "1m", "thinking", "", null, undefined, "provider/model-id"]) {
      expect(isReasoningLevelSuffix(notLevel), String(notLevel)).toBe(false);
    }
  });
});

describe("the per-account picker shows what the policy will store", () => {
  it("keeps an alias entry as-is instead of truncating it", () => {
    // The modal renders stored entries through stripReasoningLevelSuffix — the same
    // helper the policy uses — so display and storage cannot disagree.
    const stored = ["gpt-6-sol-(fast)", "gpt-6-sol-low-(fast)", "gpt-6-sol"];
    expect(stored.map(stripReasoningLevelSuffix)).toEqual(stored);
  });

  it("a bracket modifier is still removed by the policy, never by the level stripper", () => {
    expect(stripBracketSuffix("gpt-6-sol[1m]")).toBe("gpt-6-sol");
    // The level stripper must not touch it: `[1m]` is a context variant, not a level.
    expect(stripReasoningLevelSuffix("gpt-6-sol[1m]")).toBe("gpt-6-sol[1m]");
    expect(sanitizeEnabledModels(["gpt-6-sol[1m]"])).toEqual(["gpt-6-sol"]);
  });
});
