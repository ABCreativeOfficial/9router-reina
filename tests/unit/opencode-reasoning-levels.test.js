// Capability-driven reasoning levels, verified against live upstream probes.
//
// What went wrong before: every format hardcoded its own collapse
// (`max|ultra→xhigh` for openai, `low|medium→high, xhigh|max→max` for deepseek,
// `max|ultra→xhigh` in the OpenCode executor). Those rewrites threw away levels
// the upstream accepts natively and produced illegal ones for models with a
// narrower enum. Live probes through the router's own payload shape:
//
//   /inference/v1  deepseek-v4.1-flash-free  none/low/minimal/medium/high/xhigh/max → all 200
//   /inference/v1  mimo-v2.6-flash-free      low/medium/high/xhigh/max            → all 200
//   /inference/v1  glm-5.3-flash-free        deriving `thinking` objects          → 400
//                                            plain reasoning_effort               → 200
//   /inference/v1  big-pickle                none/low/medium/high                 → 200
//                                            minimal, xhigh                       → 400
//   /zen/v1        mimo-v2.6-flash-free      every level incl. minimal/max        → 200
//   /zen/v1        glm-5.3-flash-free        `thinking` object                    → 400 unknown field
//
// The old code sent `minimal`/`xhigh` to big-pickle (400), sent `max` as `xhigh`
// to models that accept `max`, and collapsed low/medium to high so the client's
// native level never reached upstream.
import { describe, expect, it } from "vitest";

import { resolveReasoningLevel, isReasoningLevel } from "../../open-sse/translator/concerns/thinking.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { OpenCodeZenExecutor } from "../../open-sse/executors/opencode-zen.js";

const apply = (targetFormat, model, body, provider) => {
  const b = structuredClone(body);
  applyThinking(targetFormat, model, b, provider);
  return b;
};

describe("resolveReasoningLevel — universal parse, capability-scoped fit", () => {
  it("returns a supported level unchanged (never downgrades a native level)", () => {
    const levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
    for (const lv of levels) expect(resolveReasoningLevel(lv, levels)).toBe(lv);
  });

  it("fits an unsupported level to the nearest declared one, ties to the higher", () => {
    // big-pickle's real enum.
    expect(resolveReasoningLevel("minimal", ["none", "low", "medium", "high"])).toBe("low");
    expect(resolveReasoningLevel("xhigh", ["none", "low", "medium", "high"])).toBe("high");
    expect(resolveReasoningLevel("max", ["none", "low", "medium", "high"])).toBe("high");
    expect(resolveReasoningLevel("ultra", ["none", "low", "medium", "high"])).toBe("high");
  });

  it("never targets \"none\" as a level — it is a disable switch, not an effort", () => {
    expect(resolveReasoningLevel("high", ["none"])).toBeNull();
    expect(resolveReasoningLevel("low", ["none", "max"])).toBe("max");
  });

  it("ultra above max on Codex stays put when declared", () => {
    const codex = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
    expect(resolveReasoningLevel("ultra", codex)).toBe("ultra");
    expect(resolveReasoningLevel("ultra", ["none", "minimal", "low", "medium", "high", "xhigh", "max"])).toBe("max");
  });

  it("passes through non-levels and unknown capability sets untouched", () => {
    expect(resolveReasoningLevel("auto", ["low", "high"])).toBe("auto");
    expect(resolveReasoningLevel("high", null)).toBe("high");
    expect(resolveReasoningLevel("high", [])).toBe("high");
  });

  it("isReasoningLevel separates wire levels from client directives", () => {
    for (const lv of ["minimal", "xhigh", "max", "ultra"]) expect(isReasoningLevel(lv)).toBe(true);
    for (const other of ["auto", "off", "", undefined, "thinking"]) expect(isReasoningLevel(other)).toBe(false);
  });
});

describe("declared levels match what each lane actually accepts", () => {
  it.each([
    // The generic *mimo*v2.6* pattern withholds "max" for the paid Go lane; the
    // free and zen lanes accept it (probed). These models cannot disable
    // thinking, so getThinkingLevels drops "none" from the declared set.
    ["opencode", "mimo-v2.6-flash-free", ["low", "medium", "high", "xhigh", "max"]],
    ["opencode-zen", "mimo-v2.6-flash-free", ["low", "medium", "high", "xhigh", "max"]],
    ["opencode", "deepseek-v4.1-flash-free", ["none", "minimal", "low", "medium", "high", "xhigh", "max"]],
    ["opencode", "glm-5.3-flash-free", ["minimal", "low", "medium", "high", "xhigh", "max"]],
    // big-pickle's enum is none|low|medium|high; offering minimal/xhigh was a 400.
    ["opencode", "big-pickle", ["none", "low", "medium", "high"]],
    // Zen lane GLM: low|high|max per vendor docs + the reference proxy.
    ["opencode-zen", "glm-5.3-flash-free", ["low", "high", "max"]],
  ])("%s/%s → %s", (provider, model, levels) => {
    expect(getThinkingLevels(provider, model)).toEqual(levels);
  });

  it("keeps the paid lanes' narrower ceilings (opencode-go mimo still drops max)", () => {
    expect(getThinkingLevels("opencode-go", "mimo-v2.6-flash")).toEqual(["low", "medium", "high", "xhigh"]);
  });
});

describe("OpenCode Free GLM-5.3-Flash — no `thinking` object, effort preserved", () => {
  it.each([
    ["opencode", "oc/glm-5.3-flash-free"],
    ["opencode-zen", "ocz/glm-5.3-flash-free"],
  ])("%s declares the OpenAI wire shape, not zai", (provider, _full) => {
    const caps = getCapabilitiesForModel(provider, "glm-5.3-flash-free");
    expect(caps.thinkingFormat).toBe("openai");
    // The model cannot disable thinking upstream.
    expect(caps.thinkingCanDisable).toBe(false);
  });

  it.each(["low", "high", "max"])("keeps reasoning_effort=%s verbatim (max must not become xhigh)", (level) => {
    const out = apply("openai", "glm-5.3-flash-free", { reasoning_effort: level }, "opencode");
    expect(out.reasoning_effort).toBe(level);
  });

  it("never emits a `thinking` field (the 400 `unknown field \"thinking\"` cause)", () => {
    for (const level of ["low", "high", "max", "none", "xhigh", "minimal"]) {
      const out = apply("openai", "glm-5.3-flash-free", { reasoning_effort: level }, "opencode");
      expect(out.thinking, level).toBeUndefined();
      // `none` cannot disable this model: it clamps to a real level instead.
      if (level !== "none") expect(out.reasoning_effort, level).toBe(level);
      else expect(out.reasoning_effort).toBeTruthy();
    }
  });

  it("a thinking-shape request is normalized to effort, not forwarded as thinking", () => {
    const out = apply("openai", "glm-5.3-flash-free", { thinking: { type: "enabled" } }, "opencode");
    expect(out.thinking).toBeUndefined();
  });

  it("z.ai's own glm-5.3-flash keeps the zai shape (provider-scoped, no global change)", () => {
    const out = apply("openai", "glm-5.3-flash", { reasoning_effort: "high" }, "glm-cn");
    expect(out.thinking).toEqual({ type: "enabled" });
    expect(out.reasoning_effort).toBe("high");
  });
});

describe("OpenCode Free DeepSeek/MiMo — native levels survive end to end", () => {
  it.each([
    ["none", "none"],
    ["minimal", "minimal"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["max", "max"],
  ])("deepseek-v4.1-flash-free keeps %s (was collapsed to high/max)", (input, expected) => {
    const out = apply("openai", "deepseek-v4.1-flash-free", { reasoning_effort: input }, "opencode");
    if (expected === "none") {
      expect(out.thinking).toEqual({ type: "disabled" });
      expect(out.reasoning_effort).toBeUndefined();
    } else {
      expect(out.thinking).toEqual({ type: "enabled" });
      expect(out.reasoning_effort).toBe(expected);
    }
  });

  it("mimo-v2.6-flash-free keeps max instead of clamping to high", () => {
    const out = apply("openai", "mimo-v2.6-flash-free", { reasoning_effort: "max" }, "opencode");
    expect(out.reasoning_effort).toBe("max");
  });

  it("a canDisable:false model asking for none clamps to a declared level, not to a disable", () => {
    const out = apply("openai", "mimo-v2.6-flash-free", { reasoning_effort: "none" }, "opencode");
    expect(out.thinking).toEqual({ type: "enabled" });
    expect(["low", "medium", "high"]).toContain(out.reasoning_effort);
  });
});

describe("big-pickle — only the levels upstream accepts", () => {
  it.each([
    ["none", "none"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["minimal", "low"],
    ["xhigh", "high"],
    ["max", "high"],
    ["ultra", "high"],
  ])("maps %s → %s (400 on minimal/xhigh upstream)", (input, expected) => {
    expect(apply("openai", "big-pickle", { reasoning_effort: input }, "opencode").reasoning_effort).toBe(expected);
  });
});

describe("final upstream payload (translator → executor)", () => {
  const TOOLS = [{ type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } } } } }];

  function wire(exec, provider, baseModel, fullId, reasoning) {
    const body = { model: fullId, messages: [{ role: "user", content: "hi" }], tools: structuredClone(TOOLS), ...reasoning };
    applyThinking("openai", baseModel, body, provider);
    const creds = exec.prepareRequestCredentials({ body, credentials: {}, providerSessionId: "payload-test", clientTool: "cli" });
    return exec.transformRequest(fullId, body, true, creds);
  }

  it("glm-5.3-flash-free sends effort only, and keeps stream + tools", () => {
    const out = wire(new OpenCodeExecutor(), "opencode", "glm-5.3-flash-free", "oc/glm-5.3-flash-free", { reasoning_effort: "max" });
    expect(out.thinking).toBeUndefined();
    expect(out.reasoning_effort).toBe("max");
    expect(out.stream).toBe(true);
    expect(out.tools.length).toBeGreaterThan(0);
  });

  it("big-pickle's wire effort is inside the enum upstream publishes", () => {
    const allowed = new Set(["none", "low", "medium", "high"]);
    for (const level of ["minimal", "low", "high", "xhigh", "max", "ultra"]) {
      const out = wire(new OpenCodeExecutor(), "opencode", "big-pickle", "oc/big-pickle", { reasoning_effort: level });
      expect(allowed.has(out.reasoning_effort), `${level} → ${out.reasoning_effort}`).toBe(true);
    }
  });

  it("deepseek-v4.1-flash-free carries its native level on the wire", () => {
    const out = wire(new OpenCodeExecutor(), "opencode", "deepseek-v4.1-flash-free", "oc/deepseek-v4.1-flash-free", { reasoning_effort: "xhigh" });
    expect(out.reasoning).toBeUndefined();
    expect(out.reasoning_effort).toBe("xhigh");
    expect(out.thinking).toEqual({ type: "enabled" });
  });

  it("zen lane emits the same effort-only payload for the free GLM", () => {
    const out = wire(new OpenCodeZenExecutor(), "opencode-zen", "glm-5.3-flash-free", "ocz/glm-5.3-flash-free", { reasoning_effort: "high" });
    expect(out.thinking).toBeUndefined();
    expect(out.reasoning_effort).toBe("high");
    expect(out.stream).toBe(true);
  });
});
