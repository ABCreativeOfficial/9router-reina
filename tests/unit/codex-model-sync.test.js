import { describe, expect, it } from "vitest";
import {
  CODEX_MODEL_CAPABILITIES,
  CODEX_INTERNAL_MODEL_CAPABILITIES,
  CODEX_PUBLIC_MODEL_IDS,
  CODEX_CLI_VERSION,
  getCodexDefaultReasoning,
  listCodexPublicModelIds,
  matchCodexBaseModel,
  parseCodexModelReference,
} from "../../open-sse/config/codexModels.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import {
  getModelsByProviderId,
  getPublicModelsByProviderId,
  getProviderModels,
  isValidModel,
} from "../../open-sse/config/providerModels.js";

/**
 * Codex catalog sync.
 *
 * The expected values below mirror the official OpenAI Codex catalog
 * (codex-rs/models-manager/models.json) filtered to visibility="list" +
 * supported_in_api=true. If upstream changes, this file is the drift alarm:
 * update open-sse/config/codexModels.js and these expectations together.
 */

/** Transform a request the way the executor does, and return the outbound body. */
function outbound(model, extraBody = {}) {
  return new CodexExecutor().transformRequest(model, {
    model,
    input: "hi",
    ...extraBody,
  }, true, {});
}

describe("Codex public catalog matches the official visible list", () => {
  it("exposes exactly the official visible chat models", () => {
    expect(CODEX_PUBLIC_MODEL_IDS).toEqual([
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
  });

  it("carries the official reasoning sets, including the models that stop early", () => {
    expect(CODEX_MODEL_CAPABILITIES["gpt-6-sol"].reasoning).toContain("ultra");
    expect(CODEX_MODEL_CAPABILITIES["gpt-6-astra"].reasoning).toContain("ultra");
    expect(CODEX_MODEL_CAPABILITIES["gpt-6-luna"].reasoning).not.toContain("ultra");
    expect(CODEX_MODEL_CAPABILITIES["gpt-5.6-luna"].reasoning).not.toContain("ultra");
    expect(CODEX_MODEL_CAPABILITIES["gpt-5.5"].reasoning).not.toContain("max");
    expect(CODEX_MODEL_CAPABILITIES["gpt-5.5"].reasoning).not.toContain("ultra");
  });

  it("carries the official per-model default reasoning", () => {
    expect(getCodexDefaultReasoning("gpt-6-astra")).toBe("low");
    expect(getCodexDefaultReasoning("gpt-6-sol")).toBe("medium");
    expect(getCodexDefaultReasoning("gpt-6-luna")).toBe("medium");
    expect(getCodexDefaultReasoning("gpt-5.6-sol")).toBe("low");
    expect(getCodexDefaultReasoning("gpt-5.6-terra")).toBe("medium");
    expect(getCodexDefaultReasoning("gpt-5.6-luna")).toBe("medium");
    expect(getCodexDefaultReasoning("gpt-5.5")).toBe("medium");
  });

  it("publishes every visible model through the registry", () => {
    const publicIds = getPublicModelsByProviderId("codex").map((m) => m.id);
    for (const id of CODEX_PUBLIC_MODEL_IDS) {
      expect(publicIds, id).toContain(id);
    }
  });

  it("drops chat models the official catalog no longer lists", () => {
    const ids = getProviderModels("cx").map((m) => m.id);
    for (const retired of ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]) {
      expect(ids, retired).not.toContain(retired);
    }
  });

  it("keeps image models untouched", () => {
    const imageIds = getModelsByProviderId("codex")
      .filter((m) => (m.kind || m.type) === "image")
      .map((m) => m.id);
    expect(imageIds).toContain("gpt-image-2.5");
    expect(imageIds).toContain("gpt-5.6-sol-image");
    expect(imageIds.length).toBeGreaterThan(5);
  });
});

describe("generic *-review aliases are gone", () => {
  it("registers no model whose id is a derived review variant", () => {
    // `codex-auto-review` is an official (hidden) catalog entry, not a derived
    // "<base>-review" sibling, so it is the one allowed id ending in "-review".
    const reviewIds = getProviderModels("cx")
      .map((m) => m.id)
      .filter((id) => id.endsWith("-review") && id !== "codex-auto-review");
    expect(reviewIds).toEqual([]);
  });

  it("never generates a review alias for a public model", () => {
    const generated = listCodexPublicModelIds().filter((id) => id.endsWith("-review"));
    expect(generated).toEqual([]);
  });

  it("keeps codex-auto-review routable but internal", () => {
    expect(CODEX_INTERNAL_MODEL_CAPABILITIES["codex-auto-review"]).toBeTruthy();
    expect(CODEX_PUBLIC_MODEL_IDS).not.toContain("codex-auto-review");
    expect(isValidModel("cx", "codex-auto-review")).toBe(true);
    expect(getPublicModelsByProviderId("codex").some((m) => m.id === "codex-auto-review")).toBe(false);
  });
});

describe("virtual alias grammar", () => {
  it("lists the generated aliases per model capability", () => {
    const ids = listCodexPublicModelIds();
    // Sol supports ultra and Fast.
    expect(ids).toContain("gpt-6-sol");
    expect(ids).toContain("gpt-6-sol-ultra");
    expect(ids).toContain("gpt-6-sol-ultra-(fast)");
    expect(ids).toContain("gpt-6-sol-(fast)");
    // Luna stops at max, so no ultra variants exist at all.
    expect(ids).toContain("gpt-6-luna-max-(fast)");
    expect(ids).not.toContain("gpt-6-luna-ultra");
    expect(ids).not.toContain("gpt-6-luna-ultra-(fast)");
    // GPT-5.5 stops at xhigh.
    expect(ids).toContain("gpt-5.5-xhigh-(fast)");
    expect(ids).not.toContain("gpt-5.5-max");
    expect(ids).not.toContain("gpt-5.5-ultra-(fast)");
  });

  it("parses base, effort and Fast without a naive dash split", () => {
    expect(parseCodexModelReference("gpt-6-sol-ultra-(fast)")).toEqual({
      ok: true, model: "gpt-6-sol", reasoningEffort: "ultra", fast: true,
    });
    expect(parseCodexModelReference("gpt-6-sol")).toEqual({
      ok: true, model: "gpt-6-sol", reasoningEffort: null, fast: false,
    });
    expect(parseCodexModelReference("gpt-6-sol-(fast)")).toEqual({
      ok: true, model: "gpt-6-sol", reasoningEffort: null, fast: true,
    });
  });

  it("longest-matches the canonical base for versioned names", () => {
    expect(matchCodexBaseModel("gpt-5.6-luna-max")).toEqual({ base: "gpt-5.6-luna", rest: "max" });
    expect(matchCodexBaseModel("gpt-6-sol-ultra")).toEqual({ base: "gpt-6-sol", rest: "ultra" });
  });

  it("rejects an unsupported combination instead of clamping it", () => {
    for (const invalid of ["gpt-6-luna-ultra", "gpt-6-luna-ultra-(fast)", "gpt-5.6-luna-ultra-(fast)", "gpt-5.5-max", "gpt-5.5-max-(fast)", "gpt-5.5-ultra-(fast)"]) {
      const parsed = parseCodexModelReference(invalid);
      expect(parsed.ok, invalid).toBe(false);
      expect(parsed.reason, invalid).toMatch(/Unsupported Codex reasoning alias/);
    }
  });

  it("names the supported levels in the rejection message", () => {
    const parsed = parseCodexModelReference("gpt-6-luna-ultra");
    expect(parsed.reason).toBe(
      'Unsupported Codex reasoning alias "ultra" for gpt-6-luna. Supported: low, medium, high, xhigh, max.',
    );
  });

  it("leaves unknown ids alone so other routing still works", () => {
    const parsed = parseCodexModelReference("some-future-model");
    expect(parsed.ok).toBe(true);
    expect(parsed.unknown).toBe(true);
    expect(parsed.model).toBe("some-future-model");
  });
});

describe("Codex outbound wire body", () => {
  const matrix = [
    ["gpt-6-astra-ultra-(fast)", "gpt-6-astra", "ultra"],
    ["gpt-6-sol-ultra-(fast)", "gpt-6-sol", "ultra"],
    ["gpt-6-luna-max-(fast)", "gpt-6-luna", "max"],
    ["gpt-5.6-sol-ultra-(fast)", "gpt-5.6-sol", "ultra"],
    ["gpt-5.6-terra-ultra-(fast)", "gpt-5.6-terra", "ultra"],
    ["gpt-5.6-luna-max-(fast)", "gpt-5.6-luna", "max"],
    ["gpt-5.5-xhigh-(fast)", "gpt-5.5", "xhigh"],
  ];

  it.each(matrix)("%s → model=%s effort=%s tier=priority", (input, expectedModel, expectedEffort) => {
    const body = outbound(input);

    expect(body.model).toBe(expectedModel);
    expect(body.reasoning.effort).toBe(expectedEffort);
    expect(body.service_tier).toBe("priority");
  });

  it("applies the official default reasoning to a canonical model", () => {
    const matrix = [
      ["gpt-6-astra", "low"],
      ["gpt-6-sol", "medium"],
      ["gpt-6-luna", "medium"],
      ["gpt-5.6-sol", "low"],
      ["gpt-5.6-terra", "medium"],
      ["gpt-5.6-luna", "medium"],
      ["gpt-5.5", "medium"],
    ];
    for (const [model, expected] of matrix) {
      const body = outbound(model);
      expect(body.model, model).toBe(model);
      expect(body.reasoning.effort, model).toBe(expected);
    }
  });

  it("applies the official default when only Fast is requested", () => {
    const body = outbound("gpt-5.6-sol-(fast)");
    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.reasoning.effort).toBe("low");
    expect(body.service_tier).toBe("priority");
  });

  it("lets an explicit reasoning effort win over the alias effort", () => {
    const body = outbound("gpt-6-sol-ultra", { reasoning_effort: "low" });
    expect(body.model).toBe("gpt-6-sol");
    expect(body.reasoning.effort).toBe("low");
  });

  it("rejects an unsupported combination at the executor", () => {
    expect(() => outbound("gpt-6-luna-ultra-(fast)")).toThrow(/Unsupported Codex reasoning alias/);
    expect(() => outbound("gpt-5.5-max")).toThrow(/Unsupported Codex reasoning alias/);
  });

  it("leaks no virtual modifier into the upstream model slug", () => {
    for (const [input] of matrix) {
      const body = outbound(input);
      expect(body.model, input).not.toMatch(/\(fast\)|\(max\)|\(ultra\)|-ultra|-max|-xhigh/);
      // The effort word may only appear as the reasoning effort value.
      expect(JSON.stringify(body.model), input).not.toContain("ultra");
    }
  });

  it("keeps fast a service tier rather than a reasoning level", () => {
    const body = outbound("gpt-6-sol-ultra-(fast)");
    expect(body.reasoning.effort).not.toBe("fast");
    expect(body.reasoning.effort).toBe("ultra");
    expect(body.service_tier).toBe("priority");
  });

  it("drops a non-priority service tier rather than forwarding it", () => {
    const body = outbound("gpt-6-sol", { service_tier: "flex" });
    expect(body.service_tier).toBeUndefined();
  });
});

describe("Codex CLI identity", () => {
  it("identifies as a version that satisfies the newest official model gate", () => {
    // The official catalog requires 0.155.0 for gpt-6-sol / gpt-6-luna; a stale
    // value makes the models endpoint silently omit them.
    const [, minor] = CODEX_CLI_VERSION.split(".").map(Number);
    expect(minor).toBeGreaterThanOrEqual(155);
  });

  it("uses the same version for the Version header and User-Agent", () => {
    expect(PROVIDERS.codex.cliVersion).toBe(CODEX_CLI_VERSION);
    expect(PROVIDERS.codex.headers["User-Agent"]).toBe(`codex_cli_rs/${CODEX_CLI_VERSION}`);
    expect(PROVIDERS.codex.headers.originator).toBe("codex_cli_rs");
  });
});

describe("non-Codex providers are untouched", () => {
  it("keeps Kiro's own GPT-5.6 level set", () => {
    // Kiro declares its own capabilities; the Codex per-model table must not leak in.
    expect(CODEX_MODEL_CAPABILITIES["gpt-5.6-sol"]).toBeTruthy();
    expect(CODEX_PUBLIC_MODEL_IDS).not.toContain("claude-sonnet-4.5");
  });

  it("does not treat a non-Codex provider's model as a Codex alias", () => {
    const parsed = parseCodexModelReference("grok-4.5-high");
    expect(parsed.ok).toBe(true);
    expect(parsed.unknown).toBe(true);
  });
});
