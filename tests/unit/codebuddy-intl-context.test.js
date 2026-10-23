import { describe, expect, it } from "vitest";
import { CODEBUDDY_CONTEXT, normalizeCodeBuddyContext } from "../../open-sse/config/codebuddyContext.js";
import {
  CodeBuddyContextError,
  compressCompletedToolOutputs,
  createCodeBuddyContextState,
  estimateCodeBuddyContext,
  getCodeBuddyBudget,
  parseCodeBuddyContextError,
  prepareCodeBuddyContext,
  protectedToolResultIds,
} from "../../open-sse/services/codebuddyContext.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { getCapabilitiesForModel, PROVIDER_CAPABILITIES } from "../../open-sse/providers/capabilities.js";
import { stripUnsupportedModalities } from "../../open-sse/translator/concerns/modality.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const policy = normalizeCodeBuddyContext({ enabled: true, contextLimit: 32768, outputReserveTokens: 1024, safetyMargin: 0, triggerThreshold: 0.9, fallbackCompression: true, keepRecentTurns: 1 });

describe("CodeBuddy context policy", () => {
  it("normalizes defaults and round-trips the public shape", () => {
    const defaults = normalizeCodeBuddyContext();
    expect(normalizeCodeBuddyContext(defaults)).toEqual(defaults);
    expect(defaults.enabled).toBe(false);
    expect(() => normalizeCodeBuddyContext({ constructor: 1 })).toThrow(/Unknown/);
    expect(() => normalizeCodeBuddyContext({ enabled: "true" })).toThrow(/Invalid/);
  });

  it("classifies 11115 and nested context-length messages without losing counts", () => {
    expect(parseCodeBuddyContextError(JSON.stringify({ code: 11115, msg: "prompt is too long: 1,052,721 tokens > 1,048,576 maximum" })))
      .toMatchObject({ inputTokens: 1052721, contextLimit: 1048576 });
    expect(parseCodeBuddyContextError(JSON.stringify({ error: { type: "invalid_request_error", code: "context_length_exceeded", message: "maximum context length is 1048576 tokens" } })))
      .toMatchObject({ contextLimit: 1048576 });
    expect(parseCodeBuddyContextError(JSON.stringify({ msg: "ordinary invalid request" }))).toBeNull();
  });

  it("serializes final payload as UTF-8 and rejects circular/unserializable input", () => {
    expect(estimateCodeBuddyContext({ tools: [{ name: "ƒ" }], messages: [{ content: "é" }] })).toBeGreaterThan(0);
    const circular = {}; circular.self = circular;
    expect(() => estimateCodeBuddyContext(circular)).toThrow(/unserializable/);
  });

  it("reserves final output and uses only verified or explicit context limits", () => {
    expect(getCodeBuddyBudget("unknown-model", { model: "unknown-model", max_tokens: 32000 }, normalizeCodeBuddyContext()).uncertain).toBe(true);
    const outputPolicy = normalizeCodeBuddyContext({ enabled: true, contextLimit: 1000000, outputReserveTokens: 4096, safetyMargin: 0.05 });
    expect(getCodeBuddyBudget("deepseek-v4.1-flash", { max_tokens: 32000 }, outputPolicy, 1000000)).toMatchObject({ contextLimit: 1000000, budget: 918000 });
    expect(getCodeBuddyBudget("unknown-model", { max_tokens: 32000 }, policy, 1048576, true)).toMatchObject({ contextLimit: 1048576, budget: 1048576 });
  });

  it("treats the verified Intl ceiling as input-only, even with large requested output", () => {
    expect(PROVIDER_CAPABILITIES["codebuddy-intl"]["deepseek-v4.1-flash"].maxInputTokens).toBe(1048576);
    const inputPolicy = normalizeCodeBuddyContext({ enabled: true, safetyMargin: 0.05 });
    const body = { messages: [{ role: "user", content: "x".repeat(2940000) }], max_completion_tokens: 393216 };
    for (const model of ["deepseek-v4.1-flash", "codebuddy-intl/deepseek-v4.1-flash(high)"]) {
      const { budget } = getCodeBuddyBudget(model, body, inputPolicy);
      expect(budget).toBe(996147);
      expect(estimateCodeBuddyContext(body)).toBeLessThan(budget);
      expect(estimateCodeBuddyContext(body)).toBeGreaterThan(budget - body.max_completion_tokens);
      expect(prepareCodeBuddyContext(body, { policy: inputPolicy }, model)).toBe(body);
    }
  });

  it.each(["deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash"])("preserves non-context capabilities for Intl %s", (model) => {
    const caps = getCapabilitiesForModel("codebuddy-intl", model);
    expect(caps).toEqual({
      ...getCapabilitiesForModel(null, model),
      contextWindow: 1048576,
      maxInputTokens: 1048576,
    });
    expect(caps).toMatchObject({ vision: true, maxOutput: 384000 });
  });

  it.each([
    { format: FORMATS.OPENAI, body: { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,fake-test-only" } }] }] } },
    { format: FORMATS.CLAUDE, body: { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "fake-test-only" } }] }] } },
    { format: FORMATS.OPENAI_RESPONSES, body: { input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,fake-test-only" }] }] } },
  ])("retains $format images before context handling when disabled", ({ format, body: source }) => {
    const body = structuredClone(source);
    const model = "deepseek-v4.1-flash";
    const state = createCodeBuddyContextState({ contextPolicy: { enabled: false } });
    stripUnsupportedModalities(body, format, getCapabilitiesForModel("codebuddy-intl", model));
    expect(prepareCodeBuddyContext(body, state, model)).toBe(body);
    expect(body).toEqual(source);
  });

  it.each([
    { upstreamLimit: null, inputOnly: false, contextLimit: 65536, budget: 57344 },
    { upstreamLimit: 32768, inputOnly: false, contextLimit: 32768, budget: 24576 },
    { upstreamLimit: 32768, inputOnly: true, contextLimit: 32768, budget: 32768 },
  ])("keeps explicit/upstream limit provenance: $upstreamLimit/$inputOnly", ({ upstreamLimit, inputOnly, contextLimit, budget }) => {
    const explicitPolicy = normalizeCodeBuddyContext({ ...policy, contextLimit: 65536 });
    expect(getCodeBuddyBudget("deepseek-v4.1-flash", { max_tokens: 8192 }, explicitPolicy, upstreamLimit, inputOnly))
      .toEqual({ contextLimit, budget, uncertain: false });
  });

  it.each(["unknown-model", "deepseek-v4-pro", "codebuddy-intl/unknown-model"])("keeps %s unknown without an explicit provider limit", (model) => {
    expect(getCodeBuddyBudget(model, { max_tokens: 393216 }, normalizeCodeBuddyContext()))
      .toEqual({ contextLimit: null, budget: null, uncertain: true });
    expect(getCodeBuddyBudget(model, { max_tokens: 8192 }, policy))
      .toEqual({ contextLimit: 32768, budget: 24576, uncertain: false });
  });

  it("never hard-rejects while disabled; preflight throws typed request error when enabled", () => {
    const state = { policy: normalizeCodeBuddyContext(), upstreamLimit: 32768 };
    expect(prepareCodeBuddyContext({ messages: [{ role: "user", content: "x".repeat(200000) }], max_tokens: 40000 }, state, "unknown", { info() {} })).toBeDefined();
    const enabled = { policy: normalizeCodeBuddyContext({ ...policy, contextLimit: 65536, outputReserveTokens: 1024 }), upstreamLimit: null, targetBudget: null, protectedIds: new Set(), contextSource: null, nativeCompaction: false };
    const body = { messages: [{ role: "user", content: "x".repeat(300000) }], max_tokens: 1024 };
    expect(() => prepareCodeBuddyContext(body, enabled, "unknown", { info() {} })).toThrow(CodeBuddyContextError);
  });

  it("does not compress unique, failed, or recent tool results", () => {
    const source = { messages: [
      { role: "user", content: "old" },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "read", input: {} }, { type: "tool_use", id: "b", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "same" }, { type: "tool_result", tool_use_id: "b", content: "same" }] },
      { role: "assistant", content: "turn completed" },
      { role: "user", content: "latest" },
    ] };
    const body = { messages: [
      { role: "user", content: "old" },
      { role: "assistant", tool_calls: [{ id: "a" }, { id: "b" }] },
      { role: "tool", tool_call_id: "a", content: "same" },
      { role: "tool", tool_call_id: "b", content: "same" },
      { role: "user", content: "latest" },
    ] };
    const out = compressCompletedToolOutputs(body, { keepRecentTurns: 1, contextSource: source, protectedIds: new Set() });
    expect(out.changed).toBe(0);
    expect(out.body.messages[3].content).toBe("same");
    expect(body.messages[3].content).toBe("same"); // immutable source
    expect(protectedToolResultIds({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", is_error: true }] }] })).toEqual(new Set(["x"]));
  });

  it.each(["string", "text-only", "document", "image", "unknown-block", "malformed-text", "object", "is_error"])("validates nested Claude tool result content before compression: %s", (kind) => {
    const text = ["large exact tool output ".repeat(32), "retained text"];
    const value = text.join("\n");
    const result = (id) => {
      let content = text.map((text) => ({ type: "text", text }));
      if (kind === "string") content = value;
      if (kind === "document" || kind === "image") content.push({ type: kind, source: { type: "base64", data: `different-${id}` } });
      if (kind === "unknown-block") content.push({ type: "unsupported", value: id });
      if (kind === "malformed-text") content.push({ type: "text", text: { value: id } });
      if (kind === "object") content = { type: "text", text: value };
      return { type: "tool_result", tool_use_id: id, content, ...(kind === "is_error" && id === "b" ? { is_error: true } : {}) };
    };
    const source = { messages: [
      { role: "user", content: "old" },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "read", input: {} }] },
      { role: "user", content: [result("a")] },
      { role: "assistant", content: [{ type: "tool_use", id: "b", name: "read", input: {} }] },
      { role: "user", content: [result("b")] },
      { role: "assistant", content: "finished" },
      { role: "user", content: "latest" },
    ] };
    const body = { messages: [
      { role: "user", content: "old" },
      { role: "assistant", tool_calls: [{ id: "a" }] },
      { role: "tool", tool_call_id: "a", content: value },
      { role: "assistant", tool_calls: [{ id: "b" }] },
      { role: "tool", tool_call_id: "b", content: value },
      { role: "user", content: "latest" },
    ] };
    const before = structuredClone({ source, body });
    const out = compressCompletedToolOutputs(body, { keepRecentTurns: 1, contextSource: source, sourceFormat: "claude" });
    const textOnly = kind === "string" || kind === "text-only";
    expect(out.changed).toBe(textOnly ? 1 : 0);
    if (textOnly) expect(out.body.messages[4].content).toMatch(/Exact duplicate/);
    else expect(out.body).toBe(body);
    expect({ source, body }).toEqual(before);
  });

  it("protects complete human-turn ranges, not just the recent user messages", () => {
    const value = "duplicate output ".repeat(100);
    const messages = ["old", "recent", "latest"].flatMap((content, turn) => [
      { role: "user", content },
      { role: "assistant", tool_calls: [{ id: `${turn}-a` }, { id: `${turn}-b` }] },
      { role: "tool", tool_call_id: `${turn}-a`, content: value },
      { role: "tool", tool_call_id: `${turn}-b`, content: value },
      { role: "assistant", content: "done" },
    ]);
    const body = { messages };
    const out = compressCompletedToolOutputs(body, { keepRecentTurns: 2 });
    expect(out.changed).toBe(1);
    expect(out.body.messages[3].content).toMatch(/Exact duplicate/);
    expect(out.body.messages.slice(5)).toEqual(messages.slice(5));
    expect(compressCompletedToolOutputs(body, { keepRecentTurns: 3 }).changed).toBe(0);
  });

  it("does not count Claude tool_result user messages as human turns", () => {
    const value = "duplicate output ".repeat(100);
    const source = { messages: [
      { role: "user", content: "older human" },
      { role: "assistant", content: [{ type: "tool_use", id: "a" }, { type: "tool_use", id: "b" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: value }, { type: "tool_result", tool_use_id: "b", content: value }] },
      { role: "assistant", content: "done" },
      { role: "user", content: "latest human" },
    ] };
    const body = { messages: [
      { role: "system", content: "instructions" },
      { role: "user", content: [{ type: "text", text: "older human" }] },
      { role: "assistant", tool_calls: [{ id: "a" }, { id: "b" }] },
      { role: "tool", tool_call_id: "a", content: value },
      { role: "tool", tool_call_id: "b", content: value },
      { role: "assistant", content: "done" },
      { role: "user", content: [{ type: "text", text: "latest human" }] },
    ] };
    expect(compressCompletedToolOutputs(body, { keepRecentTurns: 1, contextSource: source }).changed).toBe(1);
    expect(compressCompletedToolOutputs(body, { keepRecentTurns: 2, contextSource: source }).changed).toBe(0);
  });

  it.each(["orphan", "duplicate-call", "duplicate-result", "interrupted", "missing-id", "unfinished", "ambiguous-human", "translated-orphan", "mixed-result-text", "multimodal-human"])("fails closed on %s source/translated pairing", (kind) => {
    const value = "duplicate output ".repeat(100);
    const source = { messages: [
      { role: "user", content: "old" },
      { role: "assistant", content: [{ type: "tool_use", id: "a" }, { type: "tool_use", id: "b" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: value }, { type: "tool_result", tool_use_id: "b", content: value }] },
      { role: "user", content: "latest" },
    ] };
    const body = { messages: [
      { role: "user", content: "old" },
      { role: "assistant", tool_calls: [{ id: "a" }, { id: "b" }] },
      { role: "tool", tool_call_id: "a", content: value },
      { role: "tool", tool_call_id: "b", content: value },
      { role: "user", content: "latest" },
    ] };
    if (kind === "orphan") source.messages[2].content[0].tool_use_id = "wrong";
    if (kind === "duplicate-call") source.messages[1].content[1].id = "a";
    if (kind === "duplicate-result") source.messages[2].content.push(source.messages[2].content[0]);
    if (kind === "interrupted") source.messages.splice(2, 0, { role: "user", content: "interrupt" });
    if (kind === "missing-id") delete source.messages[1].content[0].id;
    if (kind === "unfinished") source.messages[2].content.pop();
    if (kind === "ambiguous-human") body.messages.splice(1, 0, { role: "user", content: "synthetic turn" });
    if (kind === "translated-orphan") body.messages[2].tool_call_id = "wrong";
    if (kind === "mixed-result-text") source.messages[2].content.push({ type: "text", text: "not a separate human turn" });
    if (kind === "multimodal-human") {
      source.messages[0].content = [{ type: "image", source: { type: "base64", data: "fake-test-only" } }];
      body.messages[0].content = [{ type: "image_url", image_url: { url: "data:image/png;base64,fake-test-only" } }];
    }
    const before = structuredClone(body);
    expect(compressCompletedToolOutputs(body, { keepRecentTurns: 1, contextSource: source }).changed).toBe(0);
    expect(body).toEqual(before);
  });

  it("fails closed on malformed pairing, protects recent user turns and overflow is request-scoped", () => {
    expect(compressCompletedToolOutputs({ messages: [{ role: "user", content: "old" }, { role: "assistant", tool_calls: [{ id: "x" }] }, { role: "tool", tool_call_id: "wrong", content: "a" }, { role: "user", content: "latest" }] }, { keepRecentTurns: 1 }).reason).toBe("orphan-tool-result");
    const e = parseCodeBuddyContextError(JSON.stringify({ code: 11115, msg: "capacity exceeded: prompt is too long" }));
    expect(checkFallbackError(400, `${e.classification}: ${e.message}`, 0, "codebuddy-intl")).toMatchObject({ shouldFallback: false, cooldownMs: 0, requestScoped: true });
    expect(CODEBUDDY_CONTEXT.requestMarker).toContain("request-scoped");
    expect(CODEBUDDY_CONTEXT.maxRecoveryRetries).toBe(1);
  });
});
