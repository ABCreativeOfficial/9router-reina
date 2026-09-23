import { describe, it, expect } from "vitest";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

describe("getThinkingLevels", () => {
  it.each([
    ["gpt-6-astra", ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-6-sol", ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-6-luna", ["none", "minimal", "low", "medium", "high", "xhigh", "max"]],
    ["gpt-5.6-sol", ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-5.6-terra", ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-5.6-luna", ["none", "minimal", "low", "medium", "high", "xhigh", "max"]],
    // Official catalog stops at xhigh for GPT-5.5.
    ["gpt-5.5", ["none", "minimal", "low", "medium", "high", "xhigh"]],
  ])("returns the official per-model levels for %s", (model, expected) => {
    expect(getThinkingLevels("codex", model)).toEqual(expected);
  });

  it("does not expose Codex-only GPT-5.6 overrides on Kiro", () => {
    expect(getThinkingLevels("kiro", "gpt-5.6-sol")).toEqual([
      "none", "minimal", "low", "medium", "high", "xhigh",
    ]);
  });

  it("does not add max for other codex models", () => {
    const levels = getThinkingLevels("codex", "gpt-5.3-codex");
    expect(levels).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("resolves levels through a virtual alias's base model", () => {
    expect(getThinkingLevels("codex", "gpt-6-luna-max-(fast)")).toEqual(
      getThinkingLevels("codex", "gpt-6-luna"),
    );
  });
});
