import { describe, expect, it } from "vitest";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";

// Free /inference lane keeps every declared effort; the keyed Zen lane remains
// low|high|max. The fork probes these lanes separately to prevent silent clamps.
const MODEL = "deepseek-v4.1-flash-free";
const PROVIDER = "opencode";
const LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const effortOnWire = (level, { model = MODEL, provider = PROVIDER, format = FORMATS.OPENAI } = {}) => {
  const body = { model, messages: [], reasoning_effort: level };
  applyThinking(format, model, body, provider);
  return body.reasoning_effort;
};

describe("oc/deepseek-v4.1-flash-free reasoning levels", () => {
  it("advertises the free lane declared levels", () => {
    expect(getThinkingLevels(PROVIDER, MODEL)).toEqual(LEVELS);
    expect(getThinkingLevels(PROVIDER, `oc/${MODEL}`)).toEqual(LEVELS);
    expect(getThinkingLevels(PROVIDER, `${MODEL}(max)`)).toEqual(LEVELS);
  });

  it("resolves the same set through the oc alias and the keyed zen lane", () => {
    expect(getThinkingLevels("oc", MODEL)).toEqual(["low", "high", "max"]);
    for (const provider of ["opencode-zen", "ocz"]) {
      expect(getThinkingLevels(provider, MODEL)).toEqual(["low", "high", "max"]);
    }
  });

  it("stays a reasoning model with the deepseek wire format", () => {
    expect(getCapabilitiesForModel(PROVIDER, MODEL)).toMatchObject({
      reasoning: true,
      thinkingFormat: "deepseek",
    });
  });

  it("forwards enabled declared levels verbatim", () => {
    for (const level of LEVELS.filter((level) => level !== "none")) expect(effortOnWire(level)).toBe(level);
  });

  it("fits undeclared levels only on the narrower keyed Zen lane", () => {
    expect(effortOnWire("minimal", { provider: "opencode-zen" })).toBe("low");
    expect(effortOnWire("medium", { provider: "opencode-zen" })).toBe("high");
    expect(effortOnWire("xhigh", { provider: "opencode-zen" })).toBe("max");
  });

  it("keeps thinking disable working (no effort on the wire)", () => {
    const body = { model: MODEL, messages: [], reasoning_effort: "none" };
    applyThinking(FORMATS.OPENAI, MODEL, body, PROVIDER);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("keeps the DeepSeek-API collapse for models whose declared set has no low", () => {
    expect(effortOnWire("low", { model: "deepseek-v4-pro", provider: "deepseek" })).toBe("high");
  });

  it("fits max to the nearest declared effort for backends that reject max", () => {
    expect(effortOnWire("max", { model: "mimo-v2.6-flash", provider: "opencode-go" })).toBe("xhigh");
  });

  it("sends the requested level to the OpenCode free chat endpoint end to end", () => {
    const executor = new OpenCodeExecutor();
    for (const level of LEVELS.filter((level) => level !== "none")) {
      // The handler strips the provider prefix before dispatch, so the executor
      // only ever sees the bare upstream id (oc/... → keep it that way).
      const body = {
        model: MODEL,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        reasoning_effort: level,
        max_tokens: 2048,
      };
      const translated = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, MODEL, body, true, {}, PROVIDER);
      const out = executor.transformRequest(MODEL, translated, true, { connectionId: "oc-deepseek-effort-test" });
      expect(executor.buildUrl(MODEL)).toBe("https://opencode.ai/inference/v1/chat/completions");
      expect(out.reasoning_effort).toBe(level);
      expect(out.model).toBe(MODEL);
    }
  });
});
