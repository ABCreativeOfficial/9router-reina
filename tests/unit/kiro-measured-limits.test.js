/**
 * Kiro live-catalog limits + refusal diagnostics.
 *
 * Measured 2026-11-21/22 against a real free-tier account with non-repetitive
 * text (deterministic pseudo-random words, so the tokenizer cannot compress):
 *
 *   input  : 210,600 tok accepted (ctx%=98.06)
 *            216,000 tok -> 400 CONTENT_LENGTH_EXCEEDS_THRESHOLD
 *            => real wall ~214,700 tokens
 *   auto   : same wall, despite the catalog advertising 1,000,000
 *   output : 200,000 accepted; catalog reports maxOutputTokens 64,000
 *   budget : max_thinking_length 16k..200k all accepted, reasoning length
 *            unchanged (794 chars at 16k vs 499 at 200k) — advisory only
 */
import { describe, expect, it } from "vitest";
import {
  KIRO_MEASURED_MAX_INPUT_TOKENS,
  KIRO_MEASURED_MAX_OUTPUT_TOKENS,
  KIRO_THINKING_BUDGET_CEILING,
  buildThinkingSystemPrefix,
} from "../../open-sse/config/kiroConstants.js";

describe("Kiro measured limits", () => {
  it("declares the measured input wall, not the advertised one", () => {
    // Largest accepted probe was 210,600; next probe (216,000) was rejected.
    // Publish the accepted figure so no client is told it has room it lacks.
    expect(KIRO_MEASURED_MAX_INPUT_TOKENS).toBe(210_000);
  });

  it("keeps the measured input wall below the catalog's advertised 1M", () => {
    // The live catalog says 1,000,000 for `auto`; publishing that makes clients
    // skip compaction and hard-fail upstream.
    expect(KIRO_MEASURED_MAX_INPUT_TOKENS).toBeLessThan(1_000_000);
  });

  it("declares the output ceiling the service accepted", () => {
    expect(KIRO_MEASURED_MAX_OUTPUT_TOKENS).toBe(200_000);
  });
});

describe("Kiro thinking budget", () => {
  it("no longer clamps to the old 32000", () => {
    // 32000 used to be a hard ceiling. The upstream accepts far more and the
    // tag is advisory, so the clamp bought nothing.
    const big = buildThinkingSystemPrefix(200_000);
    expect(big).toContain("<max_thinking_length>200000</max_thinking_length>");
    expect(big).not.toContain("<max_thinking_length>32000</max_thinking_length>");
  });

  it("still clamps at the measured ceiling", () => {
    expect(buildThinkingSystemPrefix(10_000_000)).toContain(
      `<max_thinking_length>${KIRO_THINKING_BUDGET_CEILING}</max_thinking_length>`
    );
    // 0 / negative fall back to the default rather than flooring to 1: the tag
    // is advisory, and a 1-token budget is not a meaningful request.
    expect(buildThinkingSystemPrefix(0)).toContain(
      "<max_thinking_length>16000</max_thinking_length>"
    );
    // A negative budget floors to 1 (pre-existing Math.max(1, ...) behaviour).
    expect(buildThinkingSystemPrefix(-5)).toContain("<max_thinking_length>1</max_thinking_length>");
  });
});