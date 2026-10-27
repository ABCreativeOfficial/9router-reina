import { afterEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({ fetch: vi.fn(), executor: null, saveDetail: vi.fn(async () => {}), loggerOptions: null, logTarget: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => net.fetch(...args) }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: net.saveDetail, saveRequestUsage: vi.fn(async () => {}) }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => net.executor }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async (_source, _target, _model, options) => {
  net.loggerOptions = options;
  return { logRawRequest() {}, logClientRawRequest() {}, logTargetRequest: net.logTarget, logError() {}, logProviderResponse() {}, logConvertedResponse() {} };
} }));
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { translateRequest } = await import("../../open-sse/translator/index.js");
const { parseUpstreamError } = await import("../../open-sse/utils/error.js");
const NODE = "openai-compatible-chat-synthetic";
const credentials = { apiKey: "synthetic-test-token", providerSpecificData: { baseUrl: "https://example.com/v1", apiType: "chat", newApiOrigin: "https://example.com" } };
afterEach(() => { net.fetch.mockReset(); net.saveDetail.mockClear(); net.logTarget.mockClear(); net.executor = null; net.loggerOptions = null; });

function translate(body, format = "openai", creds = credentials, provider = NODE) {
  return translateRequest(format, "openai", body.model, structuredClone(body), body.stream ?? true, { ...creds }, provider);
}

describe("New API inference parity", () => {
  it("keeps MiniMax M3.1 effort instead of replacing every level with adaptive", () => {
    const body = translate({ model: "MiniMax-M3.1-Flash", reasoning_effort: "high", messages: [{ role: "user", content: "synthetic" }] });
    expect(body.reasoning_effort).toBe("high");
  });

  it("preserves actual Claude thinking in MiniMax tool history", () => {
    const body = translate({ model: "MiniMax-M3.1-Flash", messages: [
      { role: "user", content: "synthetic" },
      { role: "assistant", content: [{ type: "thinking", thinking: "synthetic reasoning", signature: "never-forward" }, { type: "tool_use", id: "call_a", name: "probe", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: "synthetic result" }] },
    ] }, "claude");
    expect(body.messages.find(m => m.tool_calls)?.reasoning_content).toBe("synthetic reasoning");
    expect(JSON.stringify(body)).not.toContain("never-forward");
  });
});

const { isNewApiChat, parseNewApiError, summarizeNewApiRequest } = await import("../../open-sse/services/newapi/inference.js");
const { parseModel } = await import("../../open-sse/services/model.js");
describe("New API scoped regression matrix", () => {
  it.each(["low", "medium", "high", "xhigh", "max"])("keeps effort %s, including suffixed model selection", level => {
    const body = translate({ model: `MiniMax-M3.1-Flash(${level})`, messages: [{ role: "user", content: "synthetic" }] });
    expect(body.reasoning_effort).toBe(level);
    expect(body.thinking).toEqual({ type: "adaptive" });
  });
  it.each([{ thinking: { type: "disabled" } }, { reasoning_effort: "none" }, { reasoning: { effort: "none" } }])("retains model-native disable handling: %j", params => {
    const body = translate({ model: "MiniMax-M3.1-Flash", messages: [{ role: "user", content: "synthetic" }], ...params });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.reasoning_effort).toBeUndefined();
  });
  it("retains reasoning-only turns and OpenAI replay without fabricating thinking", () => {
    const body = translate({ model: "MiniMax-M3.1-Flash", messages: [
      { role: "assistant", content: "", reasoning_content: "real synthetic reasoning" },
      { role: "user", content: "continue" },
    ] });
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].reasoning_content).toBe("real synthetic reasoning");
    expect(body.messages[1].reasoning_content).toBeUndefined();
  });
  it("does not change ordinary nodes, native providers, or Responses", () => {
    const source = { model: "MiniMax-M3.1-Flash", reasoning_effort: "high", messages: [{ role: "user", content: "synthetic" }] };
    const plain = { ...credentials, providerSpecificData: { baseUrl: "https://example.com/v1", apiType: "chat" } };
    expect(translate(source, "openai", plain).thinking).toEqual({ type: "adaptive" });
    expect(translate({ ...source, model: "MiniMax-M3" }).thinking).toEqual({ type: "adaptive" });
    expect(translate(source, "openai", credentials, "openai").thinking).toEqual({ type: "adaptive" });
    expect(isNewApiChat("openai-compatible-responses-test", { ...credentials, providerSpecificData: { ...credentials.providerSpecificData, apiType: "responses" } })).toBe(false);
    expect(isNewApiChat("anthropic-compatible-test", credentials)).toBe(false);
  });
  it("sends the exact model, all 759 messages and 218 tools without speculative clipping", async () => {
    const parsed = parseModel("hc/MiniMax-M3.1-Flash");
    expect(parsed.model).toBe("MiniMax-M3.1-Flash");
    const source = { model: parsed.model, stream: true, max_tokens: 32768, stream_options: { include_usage: true },
      messages: Array.from({ length: 759 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "synthetic" })),
      tools: Array.from({ length: 218 }, (_, i) => ({ type: "function", function: { name: `probe_${i}`, parameters: { type: "object", properties: {} } } })),
    };
    const response = new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    net.fetch.mockResolvedValue(response);
    const result = await new DefaultExecutor(NODE).execute({ model: parsed.model, body: translate(source), stream: true, credentials });
    const [url, options] = net.fetch.mock.calls[0];
    const final = JSON.parse(options.body);
    expect(url).toBe("https://example.com/v1/chat/completions");
    expect(final.model).toBe("MiniMax-M3.1-Flash");
    expect(final.messages).toHaveLength(759);
    expect(final.tools).toHaveLength(218);
    expect(final.max_tokens).toBe(32768);
    expect(final.stream_options).toEqual({ include_usage: true });
    expect(result.response).toBe(response);
    expect(result.response.bodyUsed).toBe(false);
    expect(await result.response.text()).toContain("[DONE]");
  });
  it("preserves rejection details, status and correlation without secrets or payload echo", async () => {
    const body = { model: "MiniMax-M3.1-Flash", stream: true, messages: [{ role: "user", content: "private request text" }], tools: [] };
    net.fetch.mockResolvedValue(new Response(JSON.stringify({ error: { message: `Invalid request ${credentials.apiKey}`, type: "bad_response_status_code", code: "bad_response_status_code", param: "messages.3.tool_calls", Request: "private request echo", Response: "private response" }, apiKey: "private envelope token" }), { status: 400, headers: { "x-oneapi-request-id": "req-123" } }));
    const executor = new DefaultExecutor(NODE);
    const result = await executor.execute({ model: body.model, body, stream: true, credentials });
    const parsed = await parseUpstreamError(result.response, executor);
    expect(parsed.statusCode).toBe(400);
    expect(parsed.message).toContain("Invalid request");
    expect(parsed.message).toContain("code=bad_response_status_code");
    expect(parsed.message).toContain("param=messages.3.tool_calls");
    expect(parsed.message).toContain("request_id=req-123");
    expect(parsed.message).toContain('"messages":1');
    expect(parsed.message).not.toContain(credentials.apiKey);
    expect(parsed.message).not.toContain("private");
    expect(net.fetch).toHaveBeenCalledOnce();
  });
  it("preserves context errors without relabeling every 400 as overflow", () => {
    const response = new Response("", { status: 400 });
    const context = parseNewApiError(response, JSON.stringify({ error: { message: "maximum context length exceeded", code: "context_length_exceeded" } }));
    expect(context.message).toContain("context_length_exceeded");
    const generic = parseNewApiError(response, JSON.stringify({ error: { message: "Invalid request", code: "bad_response_status_code" } }));
    expect(generic.message).not.toContain("context_length_exceeded");
  });
  it("does not emit HTML or unstructured request dumps", () => {
    const parsed = parseNewApiError(new Response("", { status: 400 }), "<html>private body sk-secret</html>");
    expect(parsed.message).toContain("HTTP 400");
    expect(parsed.message).not.toMatch(/private|sk-secret|<html>/);
  });
  it("leaves other provider error bodies untouched", async () => {
    const response = new Response('{"error":{"message":"original","code":"original_code"}}', { status: 400 });
    net.fetch.mockResolvedValue(response);
    const executor = new DefaultExecutor("openai");
    const result = await executor.execute({ model: "gpt-test", body: { messages: [] }, credentials });
    expect(result.response).toBe(response);
    expect((await parseUpstreamError(response, executor)).message).toContain('"code":"original_code"');
  });
  it("summarizes UTF-8 bytes and counters without content", () => {
    const body = { messages: [{ role: "user", content: "秘密" }], tools: [{ type: "function", function: { name: "private_name" } }] };
    const summary = summarizeNewApiRequest(body);
    expect(summary.bytes).toBe(Buffer.byteLength(JSON.stringify(body)));
    expect(summary.messages).toBe(1);
    expect(summary.tools).toBe(1);
    expect(JSON.stringify(summary)).not.toMatch(/秘密|private_name/);
  });
});

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const runCore = (body, sourceFormatOverride = "openai") => handleChatCore({
  body: structuredClone(body), modelInfo: { provider: NODE, model: body.model },
  credentials: { ...credentials }, sourceFormatOverride,
  rtkEnabled: false, headroomEnabled: false, cavemanEnabled: false, ponytailEnabled: false,
});

describe("New API complete routing pipeline", () => {
  it.each(["gpt-6.1-sol", "deepseek-v4.1-flash", "glm-5.3", "MiniMax-M3.1-Flash", "vendor/future-model"])
  ("preserves genuine Claude reasoning for any template model %s", model => {
    const body = translate({ model, messages: [
      { role: "assistant", content: [{ type: "thinking", thinking: "synthetic trace", signature: "private-signature" }] },
      { role: "user", content: "continue" },
    ] }, "claude");
    expect(body.messages[0].reasoning_content).toBe("synthetic trace");
    expect(JSON.stringify(body)).not.toContain("private-signature");
  });

  it.each(["MiniMax-M3.1-Flash", "vendor/future-model"])("keeps explicit effort for %s", model => {
    expect(translate({ model, reasoning_effort: "high", messages: [{ role: "user", content: "synthetic" }] }).reasoning_effort).toBe("high");
  });

  it("propagates the final upstream error through chatCore without logging request content", async () => {
    net.executor = new DefaultExecutor(NODE);
    net.fetch.mockResolvedValue(new Response(JSON.stringify({ error: { message: "Invalid request", type: "bad_response_status_code", code: "bad_response_status_code", param: "tools.1" } }), { status: 400, headers: { "x-oneapi-request-id": "req-core" } }));
    const result = await runCore({ model: "MiniMax-M3.1-Flash(max)", stream: true, max_tokens: 32768,
      messages: [{ role: "user", content: "private message content" }],
      tools: [{ type: "function", function: { name: "private_name", parameters: { type: "object", properties: {} } } }],
    });
    const final = JSON.parse(net.fetch.mock.calls[0][1].body);
    expect(final.model).toBe("MiniMax-M3.1-Flash");
    expect(final.reasoning_effort).toBe("max");
    expect(result.status).toBe(400);
    const payload = await result.response.json();
    expect(payload.error.message).toContain("bad_response_status_code");
    expect(payload.error.message).toContain("req-core");
    expect(payload.error.message).toContain('"tools":1');
    expect(JSON.stringify(net.saveDetail.mock.calls)).not.toMatch(/private message|private_name|synthetic-test-token/);
    expect(net.loggerOptions).toEqual({ metadataOnly: true });
    const detail = net.saveDetail.mock.calls.at(-1)[0];
    expect(detail.providerRequest).toMatchObject({ messages: 1, tools: 1 });
    expect(detail.response.error).toContain("bad_response_status_code");
    expect(net.fetch).toHaveBeenCalledOnce();
  });

  it.each(["openai", "claude"])("keeps non-streaming reasoning available for %s replay", async format => {
    net.executor = new DefaultExecutor(NODE);
    net.fetch.mockResolvedValue(new Response(JSON.stringify({ id: "chatcmpl-synthetic", model: "custom-model", choices: [{ index: 0, message: { role: "assistant", content: "OK", reasoning_content: "synthetic trace" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }), { headers: { "content-type": "application/json" } }));
    const result = await runCore({ model: "custom-model", stream: false, messages: [{ role: "user", content: "synthetic" }] }, format);
    expect(result.success).toBe(true);
    const payload = await result.response.json();
    if (format === "claude") expect(payload.content).toContainEqual({ type: "thinking", thinking: "synthetic trace" });
    else expect(payload.choices[0].message.reasoning_content).toBe("synthetic trace");
    const detail = net.saveDetail.mock.calls.at(-1)[0];
    expect(detail.providerRequest.messages).toBe(1);
    expect(JSON.stringify(detail)).not.toContain("synthetic trace");
  });

  it("redacts payload dumps embedded in an upstream error message", () => {
    const parsed = parseNewApiError(new Response("", { status: 400 }), JSON.stringify({ error: { message: 'Invalid request; Request: {"messages":"private conversation"}', code: "bad_response_status_code" } }));
    expect(parsed.message).toContain("Invalid request");
    expect(parsed.message).not.toContain("private conversation");
  });
});

describe("New API streaming client round trip", () => {
  it.each(["openai", "claude"])("delivers reasoning and tool calls to %s without logging content", async format => {
    net.executor = new DefaultExecutor(NODE);
    const chunks = [
      { id: "chatcmpl-synthetic", model: "custom-model", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "synthetic private reasoning" } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_probe", type: "function", function: { name: "probe", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
    ];
    net.fetch.mockResolvedValue(new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }));
    const result = await runCore({ model: "custom-model", stream: true, messages: [{ role: "user", content: "synthetic private prompt" }], tools: format === "claude"
      ? [{ name: "probe", input_schema: { type: "object", properties: {} } }]
      : [{ type: "function", function: { name: "probe", parameters: { type: "object", properties: {} } } }],
    }, format);
    expect(result.success).toBe(true);
    const text = await result.response.text();
    expect(text).toContain("synthetic private reasoning");
    expect(text).toContain(format === "claude" ? "thinking_delta" : "reasoning_content");
    expect(text).toContain(format === "claude" ? "tool_use" : "tool_calls");
    expect(JSON.stringify(net.saveDetail.mock.calls)).not.toMatch(/synthetic private reasoning|synthetic private prompt/);
  });
});

describe("New API negative scoping and diagnostics", () => {
  it("keeps ordinary compatible Claude translation unchanged", () => {
    const plain = { ...credentials, providerSpecificData: { baseUrl: "https://example.com/v1", apiType: "chat" } };
    const body = translate({ model: "MiniMax-M3.1-Flash", messages: [
      { role: "assistant", content: [{ type: "thinking", thinking: "synthetic reasoning" }, { type: "text", text: "OK" }] },
      { role: "user", content: "continue" },
    ] }, "claude", plain);
    expect(body.messages.find(m => m.role === "assistant").reasoning_content).toBeUndefined();
  });

  it("does not infer context overflow from message or tool counts", async () => {
    const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");
    const response = new Response("", { status: 400 });
    const parsed = parseNewApiError(response, JSON.stringify({ error: { message: "Invalid request", code: "bad_response_status_code" } }), [], { messages: 759, tools: 218 });
    expect(parsed.message).not.toContain("context_length_exceeded");
    expect(checkFallbackError(parsed.status, parsed.message, 0, NODE)).toMatchObject({ shouldFallback: false, requestScoped: true, cooldownMs: 0 });
  });

  it("retains HTTP status when an upstream error body cannot be read", async () => {
    const upstream = new Response(new ReadableStream({ start(controller) { controller.error(new Error("synthetic broken body")); } }), { status: 400 });
    net.fetch.mockResolvedValue(upstream);
    const executor = new DefaultExecutor(NODE);
    const result = await executor.execute({ model: "custom-model", body: { messages: [] }, credentials });
    expect((await parseUpstreamError(result.response, executor)).statusCode).toBe(400);
  });

  it("preserves final token limits without introducing a guessed context ceiling", async () => {
    net.fetch.mockResolvedValue(new Response("", { status: 400 }));
    const body = { model: "custom-model", max_tokens: 64000, max_completion_tokens: 65536, messages: [{ role: "user", content: "synthetic" }] };
    const result = await new DefaultExecutor(NODE).execute({ model: body.model, body: translate(body), credentials });
    expect(result.transformedBody.max_tokens).toBe(64000);
    expect(result.transformedBody.max_completion_tokens).toBe(65536);
  });
});
