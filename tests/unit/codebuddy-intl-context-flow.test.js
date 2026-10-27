import { afterEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({ fetch: vi.fn(), executor: null, getProviderConnections: vi.fn(), updateProviderConnection: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => net.fetch(...args) }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => net.executor }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({ logRawRequest() {}, logClientRawRequest() {}, logTargetRequest() {}, logError() {} }),
}));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}) }));
vi.mock("@/lib/localDb", () => ({ getProviderConnections: net.getProviderConnections, updateProviderConnection: net.updateProviderConnection }));
vi.mock("@/lib/network/connectionProxy", () => ({ pickProxyPoolId: vi.fn(), resolveConnectionProxyConfig: vi.fn() }));
vi.mock("@/shared/constants/providers.js", () => ({ FREE_PROVIDERS: {}, resolveProviderId: (provider) => provider }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
const { CodeBuddyIntlExecutor } = await import("../../open-sse/executors/codebuddy-intl.js");
const { createCodeBuddyContextState } = await import("../../open-sse/services/codebuddyContext.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

const creds = { accessToken: "fake-test-token", connectionId: "test-only" };
const policy = { enabled: true, contextLimit: 32768, triggerThreshold: 0.9, safetyMargin: 0.05, outputReserveTokens: 1024, fallbackCompression: false, preferNativeCompaction: true, keepRecentTurns: 2 };
const freshContext = (contextPolicy = policy, clientTool = null, sourceBody = null) => {
  const requestContext = { sourceBody, sourceFormat: "openai" };
  requestContext.codebuddyContextState = createCodeBuddyContextState({ contextPolicy, clientTool, requestContext });
  requestContext.codebuddyContextState.model = "unknown-model";
  return requestContext;
};
const duplicateHistory = () => ({ messages: [
  { role: "user", content: "old" },
  { role: "assistant", tool_calls: [{ id: "a" }, { id: "b" }] },
  { role: "tool", tool_call_id: "a", content: "duplicate output ".repeat(200) },
  { role: "tool", tool_call_id: "b", content: "duplicate output ".repeat(200) },
  { role: "user", content: "latest" },
] });
const overflow = (status = 400) => new Response("prompt is too long: 40,000 tokens > 32,768 maximum", { status });
const runExecutor = (executor, body, requestContext, signal) => executor.execute({
  model: "unknown-model", body, stream: true, credentials: { ...creds }, signal, requestContext,
  requestPolicy: requestContext.codebuddyContextState.policy,
  recoverRequest: (response, finalBody) => executor.recoverRequest(response, finalBody, requestContext, requestContext.codebuddyContextState.policy),
});
const runCore = (body, context = policy, sourceFormatOverride = "openai") => handleChatCore({
  body: { ...body, model: "unknown-model", stream: false },
  modelInfo: { provider: "codebuddy-intl", model: "unknown-model" }, credentials: { ...creds }, connectionId: "test-only",
  sourceFormatOverride, providerOverrides: { context }, rtkEnabled: false, headroomEnabled: false, cavemanEnabled: false, ponytailEnabled: false,
});

afterEach(() => { net.fetch.mockReset(); net.getProviderConnections.mockReset(); net.updateProviderConnection.mockReset(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("CodeBuddy context overflow executor behavior", () => {
  it.each([
    { enabled: false, fallbackCompression: true, native: false, preferNativeCompaction: false, calls: 1 },
    { fallbackCompression: false, native: false, preferNativeCompaction: false, calls: 1 },
    { fallbackCompression: false, native: true, preferNativeCompaction: true, calls: 1 },
    { fallbackCompression: true, native: true, preferNativeCompaction: true, calls: 1 },
    { fallbackCompression: true, native: true, preferNativeCompaction: false, calls: 2 },
    { fallbackCompression: true, native: false, preferNativeCompaction: true, calls: 2 },
  ])("honors recovery policy $fallbackCompression/$native/$preferNativeCompaction", async ({ native, calls, ...flags }) => {
    const body = duplicateHistory();
    const context = freshContext({ ...policy, ...flags, keepRecentTurns: 1 }, native ? "claude" : null, body);
    net.fetch.mockImplementation(async () => overflow());
    const result = await runExecutor(new CodeBuddyIntlExecutor(), body, context);
    expect(net.fetch).toHaveBeenCalledTimes(calls);
    for (const [, options] of net.fetch.mock.calls) expect(options.redirect).toBe("manual");
    expect(context.codebuddyContextState.recoveryAttempts).toBe(calls - 1);
    if (calls === 2) {
      expect(net.fetch.mock.calls[1][1].body).not.toBe(net.fetch.mock.calls[0][1].body);
      expect(net.fetch.mock.calls[1][1].body).toContain("Exact duplicate");
      expect(result.contextRecoveryRetry).toBe(true);
    }
  });

  it.each(["timeout", "caller-abort", "success"])("uses an independent, cleaned-up recovery timeout: %s", async (mode) => {
    vi.useFakeTimers();
    const executor = new CodeBuddyIntlExecutor();
    executor.config = { ...executor.config, timeoutMs: 50 };
    const first = overflow();
    const caller = new AbortController();
    let firstSignal, recoverySignal;
    net.fetch.mockImplementationOnce(async (_url, options) => { firstSignal = options.signal; return first; });
    net.fetch.mockImplementationOnce((_url, options) => {
      recoverySignal = options.signal;
      if (mode === "success") return Promise.resolve(new Response("ok"));
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    });
    const requestContext = freshContext();
    let recoveryStarted;
    const started = new Promise((resolve) => { recoveryStarted = resolve; });
    const pending = executor.execute({
      model: "unknown-model", body: { messages: [{ role: "user", content: "hello" }] }, credentials: creds,
      signal: caller.signal, requestContext, recoverRequest: async (_response, body) => {
        recoveryStarted();
        return { ...body, recovery: "changed payload" };
      },
    });
    await started;
    // Flush the recovery callback before advancing the fake connect timer.
    await Promise.resolve();
    expect(recoverySignal).toBeDefined();
    expect(recoverySignal).not.toBe(firstSignal);
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(50);
    if (mode === "caller-abort") caller.abort(new Error("client disconnected"));
    const result = await pending;
    expect(result.response).toBe(mode === "success" ? await net.fetch.mock.results[1].value : first);
    expect(recoverySignal.aborted).toBe(mode !== "success");
    expect(firstSignal.aborted).toBe(mode === "caller-abort");
    expect(net.fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never replays an identical recovery payload", async () => {
    net.fetch.mockImplementation(async () => overflow());
    const result = await new CodeBuddyIntlExecutor().execute({
      model: "unknown-model", body: duplicateHistory(), credentials: creds, requestContext: freshContext(),
      recoverRequest: async (_response, body) => structuredClone(body),
    });
    expect(net.fetch).toHaveBeenCalledTimes(1);
    expect(result.terminalRequestError).toBe(true);
  });

  it.each([400, 401, 403, 429, 500])("classifies plain-text overflow at HTTP %s", (status) => {
    const parsed = new CodeBuddyIntlExecutor().parseError({ status }, "prompt is too long: 40,000 tokens > 32,768 maximum");
    expect(parsed).toMatchObject({ status: status === 401 || status === 403 ? 400 : status, contextOverflow: true, inputTokens: 40000, contextLimit: 32768 });
  });

  it.each(["upstream", "preflight"])("carries typed %s context overflow through chatCore without account locks", async (kind) => {
    net.executor = new CodeBuddyIntlExecutor();
    const refresh = vi.spyOn(net.executor, "refreshCredentials");
    net.fetch.mockImplementation(async () => overflow(403));
    const body = { messages: [{ role: "user", content: kind === "preflight" ? "quota capacity exceeded ".repeat(6000) : "hello" }] };
    const result = await runCore(body, policy, "claude");
    expect(result.contextOverflow).toBe(true);
    expect(result.status).toBe(400);
    expect(await result.response.clone().json()).toMatchObject({ type: "error", error: { type: "invalid_request_error", message: expect.stringContaining("prompt is too long") } });
    expect(refresh).not.toHaveBeenCalled();
    expect(net.fetch).toHaveBeenCalledTimes(kind === "preflight" ? 0 : 1);
    if (kind === "upstream") {
      expect(result).toMatchObject({ inputTokens: 40000, contextLimit: 32768 });
      net.getProviderConnections.mockResolvedValue([{ id: "test-only", backoffLevel: 0 }]);
      const verdict = await markAccountUnavailable("test-only", result.status, result.error, "codebuddy-intl", "unknown-model");
      expect(verdict.shouldFallback).toBe(false);
      expect(net.updateProviderConnection).not.toHaveBeenCalled();
    }
  });

  it("uses typed context metadata even when the diagnostic has no marker text", async () => {
    net.executor = new CodeBuddyIntlExecutor();
    vi.spyOn(net.executor, "isContextOverflow").mockResolvedValue(null);
    vi.spyOn(net.executor, "parseError").mockReturnValue({ status: 400, message: "opaque diagnostic", contextOverflow: true, inputTokens: 40000, contextLimit: 32768 });
    net.fetch.mockResolvedValue(new Response("opaque diagnostic", { status: 400 }));
    const result = await runCore({ messages: [{ role: "user", content: "hello" }] });
    expect(result).toMatchObject({ contextOverflow: true, inputTokens: 40000, contextLimit: 32768, error: "opaque diagnostic" });
  });

  it("keeps request-local context policy on the auth-refresh execution path", async () => {
    net.executor = new CodeBuddyIntlExecutor();
    vi.spyOn(net.executor, "refreshCredentials").mockResolvedValue({ accessToken: "fake-refreshed-token" });
    const execute = vi.spyOn(net.executor, "execute");
    net.fetch.mockResolvedValueOnce(new Response("expired token", { status: 401 }))
      .mockImplementation(async () => overflow());
    const result = await runCore(duplicateHistory(), { ...policy, fallbackCompression: true, keepRecentTurns: 1 });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][0].requestContext).toBe(execute.mock.calls[0][0].requestContext);
    expect(result.contextOverflow).toBe(true);
    expect(net.fetch).toHaveBeenCalledTimes(3);
  });

  it.each([400, 403, 500])("classifies 11133 as model request rejection without retries/refresh/locks (%s)", async (status) => {
    net.executor = new CodeBuddyIntlExecutor();
    const refresh = vi.spyOn(net.executor, "refreshCredentials");
    net.fetch.mockResolvedValue(new Response(JSON.stringify({ code: 11133, msg: "Invalid request parameters", requestId: "01a17b21d49f7000a248fdb8354eae7c",
      extError: { code: "400001", type: "invalid_request_error", param: "", message: "quota exceeded account restricted secret-body", Request: "secret-request", Response: "secret-response" } }), { status }));
    const result = await runCore({ messages: [{ role: "user", content: "hello" }] });
    expect(result.status).toBe(400);
    expect(result.error).toContain("11133");
    expect(result.error).toContain("400001");
    expect(result.error).not.toContain("secret");
    expect(result.contextOverflow).toBeUndefined();
    expect(net.fetch).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    net.getProviderConnections.mockResolvedValue([{ id: "test-only", backoffLevel: 0 }]);
    expect((await markAccountUnavailable("test-only", result.status, result.error, "codebuddy-intl", "unknown-model")).shouldFallback).toBe(false);
    expect(net.updateProviderConnection).not.toHaveBeenCalled();
  });

  it.each(["context-recovery", "auth-refresh"])("retains terminal 11133 on secondary execution: %s", async (path) => {
    net.executor = new CodeBuddyIntlExecutor();
    const refresh = vi.spyOn(net.executor, "refreshCredentials").mockResolvedValue({ accessToken: "fake-refreshed-token" });
    net.fetch.mockResolvedValueOnce(path === "context-recovery" ? overflow() : new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 11133, extError: { code: "400001" } }), { status: 403 }));
    const result = await runCore(duplicateHistory(), { ...policy, fallbackCompression: true, keepRecentTurns: 1 });
    expect(result.status).toBe(400);
    expect(result.error).toContain("11133");
    expect(net.fetch).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(path === "auth-refresh" ? 1 : 0);
    net.getProviderConnections.mockResolvedValue([{ id: "test-only", backoffLevel: 0 }]);
    expect((await markAccountUnavailable("test-only", result.status, result.error, "codebuddy-intl", "unknown-model")).shouldFallback).toBe(false);
    expect(net.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("preserves non-context upstream error formatting", async () => {
    net.executor = new CodeBuddyIntlExecutor();
    net.fetch.mockResolvedValue(new Response(JSON.stringify({ code: 11103, msg: "bad parameter" }), { status: 400 }));
    const result = await runCore({ messages: [{ role: "user", content: "hello" }] });
    expect(result.contextOverflow).toBeUndefined();
    expect(result.error).toBe("[400]: CodeBuddy rejected the request as invalid (11103): bad parameter");
    expect((await result.response.json()).error.message).toBe(result.error);
  });

  it("snapshots Claude source before translation repairs malformed tool IDs", async () => {
    net.executor = new CodeBuddyIntlExecutor();
    const execute = vi.spyOn(net.executor, "execute");
    net.fetch.mockImplementation(async () => overflow());
    const value = "duplicate output ".repeat(200);
    const source = { messages: [
      { role: "user", content: "old" },
      { role: "assistant", content: [{ type: "tool_use", id: "a!", name: "read", input: {} }, { type: "tool_use", id: "b", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a!", content: value }, { type: "tool_result", tool_use_id: "b", content: value }] },
      { role: "user", content: "latest" },
    ] };
    const before = structuredClone(source);
    const result = await runCore(source, { ...policy, fallbackCompression: true, keepRecentTurns: 1 }, "claude");
    const context = execute.mock.calls[0][0].requestContext;
    expect(context.sourceBody.messages).toEqual(before.messages);
    expect(context.codebuddyContextState.contextSource).toBe(context.sourceBody);
    expect(net.fetch.mock.calls[0][1].body).not.toContain('"id":"a!"');
    expect(net.fetch).toHaveBeenCalledTimes(1); // Changed IDs make source correspondence unverified.
    expect(result.contextOverflow).toBe(true);
  });

  it("never tees an unread successful upstream during context probing", async () => {
    net.executor = new CodeBuddyIntlExecutor();
    const upstream = new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    net.fetch.mockResolvedValue(upstream);
    const normalizeResult = vi.spyOn(net.executor, "isContextOverflow");
    const result = await runCore({ messages: [{ role: "user", content: "hello" }] }, { ...policy, enabled: false });
    expect(normalizeResult).not.toHaveBeenCalled();
    expect(result.success).toBe(false); // Empty terminal is an explicit non-replayable failure.
    expect(result.error).toContain("without replay");
  });

  it("preserves distinct explicit Responses cache sessions through translation", async () => {
    net.executor = new CodeBuddyIntlExecutor();
    net.fetch.mockImplementation(async () => overflow());
    const run = (key) => runCore({ prompt_cache_key: key, input: [{ role: "user", content: "same opening" }] }, { ...policy, enabled: false }, "openai-responses");
    await run("source-session-a");
    await run("source-session-b");
    await run("source-session-a");
    const ids = net.fetch.mock.calls.map(([, options]) => options.headers["X-Conversation-ID"]);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[2]).toBe(ids[0]);
  });

  it("keeps source snapshots and recovery state local to concurrent chatCore calls", async () => {
    net.executor = new CodeBuddyIntlExecutor();
    const execute = vi.spyOn(net.executor, "execute");
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    net.fetch.mockImplementation(async () => { await gate; return overflow(); });
    const contextPolicy = { ...policy, fallbackCompression: true, keepRecentTurns: 1 };
    const source = duplicateHistory();
    const before = structuredClone(source);
    const first = runCore(structuredClone(source), contextPolicy);
    const second = runCore(structuredClone(source), contextPolicy);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    const contexts = execute.mock.calls.map(([options]) => options.requestContext);
    expect(contexts[0]).not.toBe(contexts[1]);
    expect(contexts[0].codebuddyContextState).not.toBe(contexts[1].codebuddyContextState);
    expect(contexts[0].codebuddyContextState.contextSource).toBe(contexts[0].sourceBody);
    expect(contexts[0].sourceBody.messages).toEqual(before.messages);
    release();
    const results = await Promise.all([first, second]);
    expect(results.every((result) => result.contextOverflow)).toBe(true);
    expect(net.fetch).toHaveBeenCalledTimes(4);
    for (const context of contexts) {
      expect(context.codebuddyContextState.recoveryAttempts).toBe(1);
      expect(context.contextRecoveryTried).toBe(true);
      expect(context.sourceBody.messages).toEqual(before.messages);
    }
  });
  it("classifies 11115 terminally before BaseExecutor retries, with one network call", async () => {
    net.fetch.mockResolvedValue(new Response(JSON.stringify({ code: 11115, msg: "prompt is too long: 1,052,721 tokens > 1,048,576 maximum" }), { status: 400 }));
    const executor = new CodeBuddyIntlExecutor();
    const prepareError = vi.spyOn(executor, "prepareError");
    const result = await executor.execute({ model: "unknown-model", body: { messages: [{ role: "user", content: "hello" }] }, stream: true, credentials: creds, requestContext: freshContext(), requestPolicy: policy });
    expect(result.response.status).toBe(400);
    expect(result.terminalRequestError).toBe(true);
    expect(net.fetch).toHaveBeenCalledTimes(1);
    expect(prepareError).toHaveBeenCalledOnce();
    const parsed = executor.parseError(result.response, await result.response.clone().text());
    expect(parsed.message).toContain("context_length_exceeded");
    expect(parsed.contextOverflow).toBe(true);
  });

  it("does not consume or block successful SSE responses during overflow probing", async () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); controller.close(); } });
    net.fetch.mockResolvedValue(new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const executor = new CodeBuddyIntlExecutor();
    const prepareError = vi.spyOn(executor, "prepareError");
    const result = await executor.execute({ model: "unknown-model", body: { messages: [{ role: "user", content: "hello" }] }, stream: true, credentials: creds, requestContext: freshContext(), requestPolicy: policy });
    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toContain("[DONE]");
    expect(prepareError).not.toHaveBeenCalled();
    expect(net.fetch).toHaveBeenCalledTimes(1);
  });

  it("classifies a 403 context error as terminal before any refresh path can consume it", async () => {
    net.fetch.mockResolvedValue(new Response(JSON.stringify({ code: 11115, msg: "context_length_exceeded" }), { status: 403 }));
    const executor = new CodeBuddyIntlExecutor();
    const result = await executor.execute({ model: "unknown-model", body: { messages: [{ role: "user", content: "hello" }] }, stream: true, credentials: creds, requestContext: freshContext(), requestPolicy: policy });
    expect(result.terminalRequestError).toBe(true);
    expect(result.response.status).toBe(403);
    expect(net.fetch).toHaveBeenCalledTimes(1);
  });
});
