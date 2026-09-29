import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const NON_STREAMING = read("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const SSE_TO_JSON = read("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const RUNTIME_CONFIG = read("../../open-sse/config/runtimeConfig.js");
const ENV_EXAMPLE = read("../../.env.example");

/**
 * `/v1/messages` clients (Claude Code) do a non-streaming retry after a broken
 * stream and treat "HTTP 200 but not an Anthropic Message" as a second failure.
 *
 * The behavioural coverage for these paths lives in codex-forced-sse-claude.test.js
 * (which actually invokes the handler and asserts the returned bytes) and in
 * anthropic-message.test.js (the shape logic). What remains here is the wiring
 * check: a guard can exist in the source and still be dead code if the branch
 * above it returns first, so these assert placement, not mere presence.
 */
describe("non-streaming Anthropic Message correctness", () => {
  it("validates the Claude response shape before returning 200", () => {
    expect(NON_STREAMING).toContain("ensureAnthropicMessage(translatedResponse)");
    expect(NON_STREAMING).toContain("if (!ensured.ok)");
    // A failed validation must be a real error status, never a 200.
    expect(NON_STREAMING).toMatch(/return createErrorResult\(HTTP_STATUS\.BAD_GATEWAY, ensured\.reason\)/);
  });

  it("returns the validated message body rather than the pre-validation value", () => {
    expect(NON_STREAMING).toContain("restoreToolNames(isClaudeMessageResponse ? claudeMessage : translatedResponse, toolNameMap)");
  });

  it("guards the Responses branch BEFORE its success return, not only the chat branch", () => {
    // The original bug: the Codex/Responses branch returned a chat.completion
    // long before the Claude guard in the chat-completions branch ever ran.
    const responsesBranchStart = SSE_TO_JSON.indexOf("if (isCodexResponsesApi) {");
    const chatBranchStart = SSE_TO_JSON.indexOf("// Standard Chat Completions SSE path");
    expect(responsesBranchStart).toBeGreaterThan(-1);
    expect(chatBranchStart).toBeGreaterThan(responsesBranchStart);

    const responsesBranch = SSE_TO_JSON.slice(responsesBranchStart, chatBranchStart);
    // The Responses branch must convert for a Claude client itself...
    expect(responsesBranch).toContain("buildClaudeMessageFromResponses(jsonResponse)");
    expect(responsesBranch).toContain("classifyResponsesTerminalState(jsonResponse)");
    // ...and its conversion must precede its own success return.
    const guardIndex = responsesBranch.indexOf("buildClaudeMessageFromResponses(jsonResponse)");
    const successReturnIndex = responsesBranch.indexOf('success: true');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(successReturnIndex).toBeGreaterThan(guardIndex);
  });

  it("guards the chat-completions SSE→JSON branch too", () => {
    expect(SSE_TO_JSON).toContain("ensureAnthropicMessage(finalBody)");
    expect(SSE_TO_JSON).toMatch(/return createErrorResult\(HTTP_STATUS\.BAD_GATEWAY, ensured\.reason\)/);
  });

  it("keeps the response JSON-only (no SSE framing leaks into a JSON body)", () => {
    // Both guards run before the Response is built, and the JSON paths never
    // append [DONE]; assert no SSE sentinel is written on a JSON return.
    for (const source of [NON_STREAMING, SSE_TO_JSON]) {
      const jsonReturns = source.split("\n").filter((l) => l.includes("Content-Type\": \"application/json\""));
      expect(jsonReturns.length).toBeGreaterThan(0);
      for (const line of jsonReturns) expect(line).not.toContain("[DONE]");
    }
  });

  it("does not report success before the shape check runs", () => {
    // The validation must sit before the success bookkeeping, otherwise a body
    // that is about to be rejected is already recorded as a 200 OK.
    const validationIndex = NON_STREAMING.indexOf("ensureAnthropicMessage(translatedResponse)");
    const firstOkLog = NON_STREAMING.indexOf('status: "200 OK"');
    expect(validationIndex).toBeGreaterThan(-1);
    expect(firstOkLog).toBeGreaterThan(-1);
    expect(validationIndex).toBeLessThan(firstOkLog);
  });
});

describe("timeout defaults and env overrides", () => {
  it("documents every timeout in milliseconds with the required floors", () => {
    expect(RUNTIME_CONFIG).toContain('envMs("STREAM_STALL_TIMEOUT_MS", 900 * 1000)');
    expect(RUNTIME_CONFIG).toContain('envMs("STREAM_FIRST_CHUNK_TIMEOUT_MS", 300 * 1000)');
    expect(RUNTIME_CONFIG).toContain('envMs("FETCH_CONNECT_TIMEOUT_MS", 60 * 1000)');
    expect(RUNTIME_CONFIG).toContain('envMsAllowZero("SSE_KEEPALIVE_MS", 15 * 1000)');
  });

  it("treats SSE_KEEPALIVE_MS=0 as disabled but rejects invalid values", () => {
    // The keepalive needs a zero-means-off parser; the others must stay positive.
    expect(RUNTIME_CONFIG).toContain("function envMsAllowZero");
    expect(RUNTIME_CONFIG).toMatch(/n >= 0 \? n : def/);
    expect(RUNTIME_CONFIG).toMatch(/n > 0 \? n : def/);
  });

  it("documents the three budgets as separate concerns", () => {
    expect(RUNTIME_CONFIG).toContain("A client heartbeat must never reset either upstream budget");
    expect(RUNTIME_CONFIG).toContain("SSE_KEEPALIVE_MS");
  });

  it("ships the variables in .env.example", () => {
    for (const name of ["SSE_KEEPALIVE_MS", "FETCH_CONNECT_TIMEOUT_MS", "STREAM_FIRST_CHUNK_TIMEOUT_MS", "STREAM_STALL_TIMEOUT_MS"]) {
      expect(ENV_EXAMPLE, name).toContain(name);
    }
    expect(ENV_EXAMPLE).toMatch(/milliseconds/i);
  });
});

describe("keepalive cannot reset the upstream stall budget", () => {
  it("layers the heartbeat outside the stall watchdog", () => {
    const STREAMING = read("../../open-sse/handlers/chatCore/streamingHandler.js");
    const pipeIndex = STREAMING.indexOf("pipeWithDisconnect(providerResponse");
    const keepaliveIndex = STREAMING.indexOf("withSseKeepalive(transformedBody");
    expect(pipeIndex).toBeGreaterThan(-1);
    expect(keepaliveIndex).toBeGreaterThan(-1);
    // The heartbeat wraps the already-guarded stream, so upstream byte activity
    // (which arms/clears the stall timer) is measured upstream of it.
    expect(pipeIndex).toBeLessThan(keepaliveIndex);
  });

  it("keeps stall arming tied to raw upstream chunks only", () => {
    const HANDLER = read("../../open-sse/utils/streamHandler.js");
    // armStall() must be invoked only from the upstream tap (initial arm plus the
    // per-chunk re-arm). Any call elsewhere would let something other than raw
    // upstream bytes extend the stall budget.
    const armCalls = HANDLER.split("\n").filter((l) => /^\s*armStall\(\);/.test(l));
    expect(armCalls.length).toBe(2);
    // The per-chunk re-arm lives inside the upstream tap's transform.
    const tapIndex = HANDLER.indexOf("const upstreamTap = new TransformStream");
    const rearmIndex = HANDLER.indexOf("armStall();", HANDLER.indexOf("transform(chunk, controller)"));
    expect(tapIndex).toBeGreaterThan(-1);
    expect(rearmIndex).toBeGreaterThan(tapIndex);
    // The heartbeat module must not import the stall budget at all.
    const KEEPALIVE = read("../../open-sse/utils/sseKeepalive.js");
    expect(KEEPALIVE).not.toContain("STREAM_STALL_TIMEOUT_MS");
    expect(KEEPALIVE).not.toContain("STREAM_FIRST_CHUNK_TIMEOUT_MS");
  });
});

describe("keepalive is scoped to the client-facing stream", () => {
  it("is applied once, in the streaming handler only", () => {
    const KEEPALIVE = read("../../open-sse/utils/sseKeepalive.js");
    expect(KEEPALIVE).toContain("export function withSseKeepalive");
    // Non-streaming paths must never emit SSE frames at all.
    expect(NON_STREAMING).not.toContain("withSseKeepalive");
    expect(SSE_TO_JSON).not.toContain("withSseKeepalive");
  });

  it("uses a comment frame that no parser reads as content", () => {
    const KEEPALIVE = read("../../open-sse/utils/sseKeepalive.js");
    expect(KEEPALIVE).toContain('SSE_KEEPALIVE_FRAME = ": ping\\n\\n"');
  });
});
