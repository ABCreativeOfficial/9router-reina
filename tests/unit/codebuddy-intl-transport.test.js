import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeCodeBuddyPayload, normalizeCodeBuddyStream } from "../../open-sse/utils/codebuddyWire.js";
import { conversationKey, resetConversationStore } from "../../open-sse/utils/conversationHeaders.js";

const net = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => net.fetch(...args) }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}) }));
const { CodeBuddyIntlExecutor } = await import("../../open-sse/executors/codebuddy-intl.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.js");
const { parseSSEToOpenAIResponse, handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { pipeWithDisconnect, createStreamController } = await import("../../open-sse/utils/streamHandler.js");
const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");
const { handleStreamingResponse } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
const { handleComboChat } = await import("../../open-sse/services/combo.js");
const encoder = new TextEncoder();
const response = (text) => new Response(text, { headers: { "Content-Type": "text/event-stream" } });
const credentials = { accessToken: "test-token" };
afterEach(() => { net.fetch.mockReset(); resetConversationStore(); });

describe("CodeBuddy IDE transport compatibility", () => {
  it("mirrors actual reasoning, preserves conflicts, tools and media without mutating input", () => {
    const body = { reasoning_effort: "high", reasoningEffort: "low", messages: [
      { role: "assistant", content: null, reasoning: "real reasoning", tool_calls: [{ id: "call_a", function: { name: "read", arguments: "{}" } }] },
      { role: "assistant", reasoning: "a", reasoning_content: "b" },
      { role: "assistant", content: "plain" },
      { role: "tool", tool_call_id: "call_a", content: "[1,2]" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }] },
    ] };
    const before = structuredClone(body);
    const out = normalizeCodeBuddyPayload(body);
    expect(out.messages[0].reasoning_content).toBe("real reasoning");
    expect(out.messages[1]).toEqual(body.messages[1]);
    expect(out.messages[2]).not.toHaveProperty("reasoning_content");
    expect(out.messages.slice(3)).toEqual(body.messages.slice(3));
    expect(out).not.toHaveProperty("reasoningEffort");
    expect(body).toEqual(before);
  });

  it("decodes byte-fragmented UTF-8, CRLF and multiline events, repairs tool type and usage", async () => {
    const text = 'data: {"choices":[\r\ndata: {"delta":{"content":"é","tool_calls":[{"index":0,"id":"a","type":"","function":{"name":"read","arguments":"{}"}}]}}]}\r\n\r\ndata: {"choices":null,"usage":{"prompt_tokens":4},"done":true}\r\n\r\ndata: garbage\n\n';
    const bytes = encoder.encode(text);
    let index = 0;
    const cancel = vi.fn();
    const upstream = new ReadableStream({ pull(c) { if (index < bytes.length) c.enqueue(bytes.slice(index, ++index)); else c.close(); }, cancel });
    const out = await normalizeCodeBuddyStream(new Response(upstream, { headers: { "content-type": "text/event-stream" } })).text();
    expect(out).toContain('"content":"é"');
    expect(out).toContain('"type":"function"');
    expect(out).toContain('"choices":[]');
    expect(out).toContain('"prompt_tokens":4');
    expect(out).not.toContain('"done"');
    expect(out).not.toContain("garbage");
    expect(out).toContain("data: [DONE]");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not drain before reads and cancels an upstream that stays open after DONE", async () => {
    const pull = vi.fn((c) => c.enqueue(encoder.encode("data: [DONE]\n\n")));
    const cancel = vi.fn();
    const upstream = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    const normalized = normalizeCodeBuddyStream(new Response(upstream, { headers: { "content-type": "text/event-stream" } }));
    await Promise.resolve();
    expect(pull).not.toHaveBeenCalled();
    expect(await normalized.text()).toContain("data: [DONE]\n\n");
    expect(pull).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(['event: error\ndata: {"message":"private upstream body"}\n\n', 'data: {"error":{"message":"secret"}}\n\n', 'data: {"choices":[{"finish_reason":"error"}]}\n\n', 'data: invalid\n\n'])('fails explicitly on an invalid/error stream: %s', async (text) => {
    await expect(normalizeCodeBuddyStream(response(text)).text()).rejects.toThrow(/CodeBuddy/);
  });

  it("preserves heartbeat liveness, ignores unrelated named events and cancels on disconnect", async () => {
    const cancel = vi.fn();
    let sent = false;
    const upstream = new ReadableStream({ pull(c) { if (!sent) { sent = true; c.enqueue(encoder.encode(": private heartbeat\r\n\r\nevent: ping\ndata: not-json\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n")); } }, cancel }, { highWaterMark: 0 });
    const reader = normalizeCodeBuddyStream(new Response(upstream, { headers: { "content-type": "text/event-stream" } })).body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toBe(": keepalive\n\n");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"content":"ok"');
    await reader.cancel("client disconnected");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("ignores a terminal-looking payload on unrelated named events", async () => {
    const out = await normalizeCodeBuddyStream(response('event: ping\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"content":"kept"}}]}\n\ndata: [DONE]\n\n')).text();
    expect(out).toContain("kept");
  });

  it("accepts batches larger than the limit when each individual event fits", async () => {
    const event = `data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(1024) } }] })}\n\n`;
    const out = await normalizeCodeBuddyStream(response(event.repeat(4100) + "data: [DONE]\n\n")).text();
    expect(out.match(/data: /g)).toHaveLength(4101);
  });

  it("recognizes CR-only DONE immediately without waiting for another byte", async () => {
    let sent = false;
    const cancel = vi.fn();
    const upstream = new ReadableStream({ pull(c) { if (!sent) { sent = true; c.enqueue(encoder.encode("data: [DONE]\r\r")); } }, cancel }, { highWaterMark: 0 });
    expect(await normalizeCodeBuddyStream(new Response(upstream, { headers: { "content-type": "text/event-stream" } })).text()).toContain("data: [DONE]\n\n");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["", "data: [DONE]\n\n", 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{"}}]}}]}'])
  ("rejects truncated/empty EOF and prevents replay", async (text) => {
    const result = await handleForcedSSEToJson({ providerResponse: normalizeCodeBuddyStream(response(text)), provider: "codebuddy-intl",
      sourceFormat: "openai", targetFormat: "openai", model: "test", body: {}, trackDone() {}, appendLog() {} });
    expect(result.success).toBe(false);
    expect(checkFallbackError(result.status, result.error)).toMatchObject({ shouldFallback: false, cooldownMs: 0 });
  });

  it.each(["[DONE]", "", "malformed", '{"message":"secret"}'])("error events cannot be mistaken for successful terminals: %s", async (data) => {
    await expect(normalizeCodeBuddyStream(response(`event: error\ndata: ${data}\n\n`)).text()).rejects.toThrow(/stream failed/);
  });

  it("reports raw fragments to the watchdog while an SSE event is incomplete", async () => {
    let sent = false;
    const upstream = new ReadableStream({ pull(c) { if (!sent) { sent = true; c.enqueue(encoder.encode('data: {"choices":')); } } }, { highWaterMark: 0 });
    const reader = normalizeCodeBuddyStream(new Response(upstream, { headers: { "content-type": "text/event-stream" } })).body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": keepalive\n\n");
    await reader.cancel();
  });

  it("rejects an unbounded event instead of buffering forever", async () => {
    await expect(normalizeCodeBuddyStream(response("data: " + "x".repeat(4 * 1024 * 1024 + 1))).text()).rejects.toThrow(/size limit/);
  });

  it("normalizes content, reasoning, tool argument fragments and usage for existing consumers", async () => {
    const text = [
      { id: "chatcmpl-test", model: "test", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "think", content: "ok", tool_calls: [{ index: 0, id: "call_a", type: "", function: { name: "read", arguments: '{"p":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, finish_reason: "tool_calls" }] },
      { choices: null, usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }, done: true },
    ].map((p) => `data: ${JSON.stringify(p)}\n\n`).join("");
    const raw = await normalizeCodeBuddyStream(response(text)).text();
    const json = parseSSEToOpenAIResponse(raw, "test");
    expect(json.choices[0].message.content).toBe("ok");
    expect(json.choices[0].message.tool_calls[0].function.arguments).toBe('{"p":"a"}');
    expect(json.usage.total_tokens).toBe(6);
    for (const format of ["openai", "claude"]) {
      const result = await handleForcedSSEToJson({ providerResponse: normalizeCodeBuddyStream(response(text)), provider: "codebuddy-intl",
        sourceFormat: format, targetFormat: "openai", model: "test", body: {}, requestStartTime: Date.now(), trackDone() {}, appendLog() {} });
      expect(result.success).toBe(true);
      const payload = await result.response.json();
      expect(payload.usage).toMatchObject(format === "claude" ? { input_tokens: 4, output_tokens: 2 } : { total_tokens: 6 });
      if (format === "claude") expect(payload.content).toContainEqual({ type: "tool_use", id: "call_a", name: "read", input: { p: "a" } });
      else expect(payload.choices[0].message.tool_calls[0].function.arguments).toBe('{"p":"a"}');
    }
    for (const format of ["openai", "claude"]) {
      const transform = format === "openai" ? createPassthroughStreamWithLogger("codebuddy-intl")
        : createSSETransformStreamWithLogger("openai", format, "codebuddy-intl");
      const out = await new Response(normalizeCodeBuddyStream(response(text)).body.pipeThrough(transform)).text();
      expect(out).toContain("ok");
      expect(out).toContain(format === "claude" ? "tool_use" : "tool_calls");
    }
  });

  it.each(["openai", "claude"])("surfaces stream errors to %s clients without successful completion", async (format) => {
    const upstream = normalizeCodeBuddyStream(response('data: {"error":{"message":"secret"}}\n\n'));
    const { buildStreamErrorBytes } = await import("../../open-sse/utils/streamHelpers.js");
    const transform = format === "openai" ? createPassthroughStreamWithLogger("codebuddy-intl")
      : createSSETransformStreamWithLogger("openai", format, "codebuddy-intl");
    const controller = createStreamController({ log: { errorLine() {} } });
    const stream = pipeWithDisconnect(upstream, transform, controller, () => buildStreamErrorBytes(502, "CodeBuddy stream failed", format));
    const out = await new Response(stream).text();
    expect(out).toContain('"error"');
    expect(out).not.toContain("secret");
    expect(out).not.toContain("message_stop");
  });

  it.each(["openai", "claude"])("returns a terminal non-replayable %s JSON error", async (format) => {
    const result = await handleForcedSSEToJson({ providerResponse: normalizeCodeBuddyStream(response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {"error":"secret"}\n\n')),
      provider: "codebuddy-intl", sourceFormat: format, targetFormat: "openai", model: "test", body: {}, trackDone() {}, appendLog() {} });
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(checkFallbackError(502, result.error)).toMatchObject({ shouldFallback: false, cooldownMs: 0 });
    const payload = await result.response.json();
    expect(payload.error.message).not.toContain("secret");
    if (format === "claude") expect(payload.type).toBe("error");
  });

  it.each(["openai", "claude"])("does not replay a %s stream error through combo empty-failover", async (format) => {
    const log = { info() {}, warn() {}, error() {}, debug() {}, errorLine() {} };
    const handleSingleModel = vi.fn(async () => (await handleStreamingResponse({
      providerResponse: normalizeCodeBuddyStream(response('data: {"error":"secret"}\n\n')),
      provider: "codebuddy-intl", model: "test", sourceFormat: format, targetFormat: "openai", body: {}, stream: true,
      requestStartTime: Date.now(), streamController: createStreamController({ log }), log,
    })).response);
    const result = await handleComboChat({ body: { messages: [{ role: "user", content: "hello" }], stream: true }, models: ["cbai/glm-5.2", "cbai/deepseek-v4.1-flash"], handleSingleModel, log, comboName: "wire-error-test" });
    expect(handleSingleModel).toHaveBeenCalledOnce();
    const out = await result.text();
    expect(out).toContain("without replay");
    expect(out).not.toContain("secret");
  });

  it("keeps non-Intl fetch redirect defaults unchanged", async () => {
    net.fetch.mockResolvedValue(new Response("ok"));
    await new DefaultExecutor("openai").execute({ model: "test", body: { messages: [] }, credentials });
    expect(net.fetch.mock.calls[0][1]).not.toHaveProperty("redirect");
  });

  it("forces manual redirects and rejects redirect responses without leaking Location", async () => {
    net.fetch.mockResolvedValue(new Response("redirect", { status: 307, headers: { location: "https://elsewhere.test/secret" } }));
    const result = await new CodeBuddyIntlExecutor().execute({ model: "test", body: { messages: [{ role: "user", content: "hi" }] }, credentials });
    expect(net.fetch).toHaveBeenCalledOnce();
    expect(net.fetch.mock.calls[0][1].redirect).toBe("manual");
    expect(result.response.status).toBe(502);
    expect(await result.response.text()).not.toContain("elsewhere");
    expect(result.response.headers.has("location")).toBe(false);
  });

  it("uses a request-local source cache key after translation and isolates identical openings", async () => {
    const executor = new CodeBuddyIntlExecutor();
    const sharedCredentials = { ...credentials };
    const run = async (key) => {
      net.fetch.mockResolvedValueOnce(response("data: [DONE]\n\n"));
      const result = await executor.execute({ model: "test", body: { messages: [{ role: "user", content: "same opening" }] }, credentials: sharedCredentials,
        requestContext: { codebuddyConversationKey: conversationKey({ body: { prompt_cache_key: key }, scope: "codebuddy-intl" }) } });
      await result.response.text();
      return result.headers["X-Conversation-ID"];
    };
    const a = await run("session-a");
    expect(await run("session-b")).not.toBe(a);
    expect(await run("session-a")).toBe(a);
    expect(sharedCredentials).not.toHaveProperty("_codebuddyConversationKey");
  });
});
