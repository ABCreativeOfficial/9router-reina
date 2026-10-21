// The intl gateway's channel verification rejects a chat request without the
// X-Conversation-* family (HTTP 400 code 11128 "conversation id missing").
// Shapes and id relationships are the capture-verified ones from upstream
// PR #4949; the required set is the three X-Conversation-* headers (PR #4944).
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodeBuddyIntlExecutor, normalizeIntlMessages, neutralizeIdentityPrompt } from "../../open-sse/executors/codebuddy-intl.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";
import {
  ensureConversationHeaders,
  resetConversationStore,
  uuid7,
  uuid7Hex,
} from "../../open-sse/utils/conversationHeaders.js";

const URL_ = "https://www.codebuddy.ai/v2/chat/completions";
const CREDS = { accessToken: "test-token", connectionId: "conn-a" };
const DASHED_UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{32}$/;

const CONVERSATION_HEADERS = [
  "X-Conversation-ID",
  "X-Conversation-Request-ID",
  "X-Conversation-Message-ID",
];
const TRACE_HEADERS = [
  "X-Trace-ID",
  "traceparent",
  "b3",
  "X-B3-TraceId",
  "X-B3-SpanId",
  "X-B3-Sampled",
];

const buildHeaders = (body = null, credentials = CREDS) =>
  new CodeBuddyIntlExecutor().buildHeaders(credentials, true, URL_, "glm-5.2", body);

const keysMatching = (headers, name) =>
  Object.keys(headers).filter((key) => key.toLowerCase() === name.toLowerCase());

afterEach(() => {
  resetConversationStore();
  vi.restoreAllMocks();
});

describe("conversation header family", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };

  it("always sends the three required headers", () => {
    const headers = buildHeaders(body);
    for (const name of CONVERSATION_HEADERS) expect(headers[name], name).toBeTruthy();
  });

  it("uses the captured id shapes", () => {
    const headers = buildHeaders(body);
    expect(headers["X-Conversation-ID"]).toMatch(DASHED_UUID7);
    for (const name of ["X-Conversation-Request-ID", "X-Conversation-Message-ID", "X-Request-ID", "X-Root-Request-ID"]) {
      expect(headers[name], name).toMatch(HEX32);
    }
  });

  it("keeps the captured id relationships", () => {
    const headers = buildHeaders(body);
    expect(headers["X-Root-Request-ID"]).toBe(headers["X-Conversation-Request-ID"]);
    expect(headers["X-Request-ID"]).toBe(headers["X-Conversation-Request-ID"]);
    expect(headers["X-Conversation-Message-ID"]).not.toBe(headers["X-Request-ID"]);
  });

  it("sends the W3C / B3 trace family derived from one trace id", () => {
    const headers = buildHeaders(body);
    for (const name of TRACE_HEADERS) expect(headers[name], name).toBeTruthy();
    expect(headers.traceparent).toBe(`00-${headers["X-Trace-ID"]}-${headers["X-B3-SpanId"]}-01`);
    expect(headers.b3).toBe(`${headers["X-Trace-ID"]}-${headers["X-B3-SpanId"]}-1`);
    expect(headers["X-B3-TraceId"]).toBe(headers["X-Trace-ID"]);
    expect(headers["X-B3-Sampled"]).toBe("1");
  });

  it("still sends the family when there is no body at all", () => {
    for (const empty of [null, undefined]) {
      const headers = buildHeaders(empty);
      for (const name of CONVERSATION_HEADERS) expect(headers[name], name).toBeTruthy();
    }
  });
});

describe("conversation id derivation", () => {
  const body = { messages: [{ role: "user", content: "same opening message" }] };

  it("stays stable across retries of the same turn", () => {
    const a = buildHeaders(body);
    const b = buildHeaders(body);
    expect(a["X-Conversation-ID"]).toBe(b["X-Conversation-ID"]);
    // Per-request ids must stay fresh between separate builds.
    expect(a["X-Conversation-Request-ID"]).not.toBe(b["X-Conversation-Request-ID"]);
    expect(a["X-Conversation-Message-ID"]).not.toBe(b["X-Conversation-Message-ID"]);
  });

  it("stays stable across account failover (connection id is not part of the key)", () => {
    const a = buildHeaders(body, { ...CREDS, connectionId: "conn-a" });
    const b = buildHeaders(body, { ...CREDS, connectionId: "conn-b" });
    expect(a["X-Conversation-ID"]).toBe(b["X-Conversation-ID"]);
  });

  it("prefers a Claude Code session header over the message-derived key", () => {
    const withSession = (sid) => buildHeaders(
      { messages: [{ role: "user", content: "hi" }] },
      { ...CREDS, rawHeaders: { "x-claude-code-session-id": sid } },
    );
    const a = withSession("sess-123");
    const b = withSession("sess-123");
    const c = withSession("sess-456");
    expect(a["X-Conversation-ID"]).toBe(b["X-Conversation-ID"]);
    expect(c["X-Conversation-ID"]).not.toBe(a["X-Conversation-ID"]);
  });

  it("reads the Claude Code session from metadata.user_id", () => {
    const withUser = (userId) => buildHeaders(
      { messages: [{ role: "user", content: "hi" }], metadata: { user_id: userId } },
      CREDS,
    );
    const a = withUser("user_abc_account_xyz_session_11111111-1111-1111-1111-111111111111");
    const b = withUser("user_abc_account_xyz_session_11111111-1111-1111-1111-111111111111");
    const c = withUser("user_abc_account_xyz_session_22222222-2222-2222-2222-222222222222");
    expect(a["X-Conversation-ID"]).toBe(b["X-Conversation-ID"]);
    expect(c["X-Conversation-ID"]).not.toBe(a["X-Conversation-ID"]);
  });

  it("isolates two conversations that open with different user messages", () => {
    const a = buildHeaders({ messages: [{ role: "user", content: "first conversation" }] });
    const b = buildHeaders({ messages: [{ role: "user", content: "second conversation" }] });
    expect(a["X-Conversation-ID"]).not.toBe(b["X-Conversation-ID"]);
  });

  it("supports typed-block user content for the derived key", () => {
    const headers = buildHeaders({
      messages: [{ role: "user", content: [{ type: "text", text: "typed block" }] }],
    });
    expect(headers["X-Conversation-ID"]).toMatch(DASHED_UUID7);
  });

  it("falls back to a fresh id when there is nothing to derive from", () => {
    const a = buildHeaders({ messages: [] });
    const b = buildHeaders({ messages: [] });
    expect(a["X-Conversation-ID"]).toMatch(DASHED_UUID7);
    expect(a["X-Conversation-ID"]).not.toBe(b["X-Conversation-ID"]);
  });
});

describe("UUIDv7 generation", () => {
  it("sets the version and variant nibbles", () => {
    for (let i = 0; i < 50; i++) expect(uuid7()).toMatch(DASHED_UUID7);
  });

  it("is unique and monotonic within one millisecond burst", () => {
    const ids = Array.from({ length: 2000 }, () => uuid7());
    expect(new Set(ids).size).toBe(ids.length);
    // Timestamp prefix never goes backwards.
    const stamps = ids.map((id) => id.slice(0, 13).replace(/-/g, ""));
    expect([...stamps].sort()).toEqual(stamps);
  });

  it("produces the 32-hex form for request ids", () => {
    expect(uuid7Hex()).toMatch(HEX32);
  });
});

describe("caller-supplied ids are preserved", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };

  it("keeps non-empty values and only fills the gaps", () => {
    const headers = ensureConversationHeaders({
      "X-Conversation-ID": "11111111-1111-1111-1111-111111111111",
      "X-Conversation-Message-ID": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }, body);
    expect(headers["X-Conversation-ID"]).toBe("11111111-1111-1111-1111-111111111111");
    expect(headers["X-Conversation-Message-ID"]).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(headers["X-Request-ID"]).toBe(headers["X-Conversation-Request-ID"]);
    expect(headers["X-Conversation-Request-ID"]).toMatch(HEX32);
  });

  it("treats blank values as absent", () => {
    const headers = ensureConversationHeaders({ "X-Conversation-ID": "   " }, body);
    expect(headers["X-Conversation-ID"]).toMatch(DASHED_UUID7);
  });

  it("normalises a 32-hex conversation id to the dashed shape", () => {
    const headers = ensureConversationHeaders({ "X-Conversation-ID": "018f0a1b2c3d7e4f8a9b0c1d2e3f4a5b" }, body);
    expect(headers["X-Conversation-ID"]).toBe("018f0a1b-2c3d-7e4f-8a9b-0c1d2e3f4a5b");
  });

  it("rotates nothing on a second pass over the same bag", () => {
    const first = buildHeaders(body);
    const second = ensureConversationHeaders({ ...first }, body);
    for (const name of [...CONVERSATION_HEADERS, "X-Request-ID", "X-Root-Request-ID", ...TRACE_HEADERS]) {
      expect(second[name], name).toBe(first[name]);
    }
  });
});

describe("header lookup and writes are case-insensitive", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };

  it("does not duplicate a caller's lowercase conversation id", () => {
    const headers = ensureConversationHeaders({ "x-conversation-id": "caller-lower" }, body);
    expect(keysMatching(headers, "x-conversation-id")).toHaveLength(1);
    expect(headers["x-conversation-id"]).toBe("caller-lower");
  });

  it("does not duplicate a caller's mixed-case message id", () => {
    const headers = ensureConversationHeaders({ "X-Conversation-Message-Id": "caller-mixed" }, body);
    expect(keysMatching(headers, "x-conversation-message-id")).toHaveLength(1);
    expect(headers["X-Request-ID"]).toBe(headers["X-Conversation-Request-ID"]);
  });

  it("recognises a lowercase X-Request-ID when mirroring", () => {
    const headers = ensureConversationHeaders({ "x-request-id": "caller-trace" }, body);
    expect(headers["x-request-id"]).toBe("caller-trace");
    expect(headers["X-Conversation-Request-ID"]).toBe("caller-trace");
    expect(headers["X-Conversation-Message-ID"]).not.toBe("caller-trace");
  });

  it("fills a fetch Headers instance instead of adding plain properties", () => {
    const headers = ensureConversationHeaders(new Headers({ "x-conversation-id": "caller-lower" }), body);
    expect(headers.get("X-Conversation-ID")).toBe("caller-lower");
    expect(headers.get("X-Conversation-Request-ID")).toBeTruthy();
    expect(headers.get("X-Conversation-Message-ID")).toBeTruthy();
    expect(headers["X-Conversation-ID"]).toBeUndefined();
  });
});

// providerOverrides is merged with Object.assign AFTER buildHeaders. A lowercase
// override key would otherwise leave two case-variant keys, which the fetch layer
// joins into one comma-separated value — corrupting the id.
describe("providerOverrides cannot corrupt the family", () => {
  it("keeps exactly one key and honours the override value", async () => {
    const captured = {};
    const spy = vi.spyOn(proxyFetchModule, "proxyAwareFetch")
      .mockImplementation(async (url, init) => {
        captured.url = url;
        captured.headers = init.headers;
        captured.body = init.body;
        return { ok: true, status: 200, headers: new Map() };
      });

    const executor = new CodeBuddyIntlExecutor();
    await executor.execute({
      model: "glm-5.2",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: CREDS,
      providerOverrides: { headers: { "x-conversation-id": "11111111-1111-1111-1111-111111111111" } },
    });

    expect(keysMatching(captured.headers, "x-conversation-id")).toHaveLength(1);
    expect(captured.headers["x-conversation-id"]).toBe("11111111-1111-1111-1111-111111111111");
    spy.mockRestore();
  });

  it("regenerates a family header the override blanked out", async () => {
    const captured = {};
    const spy = vi.spyOn(proxyFetchModule, "proxyAwareFetch")
      .mockImplementation(async (url, init) => {
        captured.headers = init.headers;
        return { ok: true, status: 200, headers: new Map() };
      });

    await new CodeBuddyIntlExecutor().execute({
      model: "glm-5.2",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: CREDS,
      providerOverrides: { headers: { "X-Conversation-Message-ID": "" } },
    });

    expect(captured.headers["X-Conversation-Message-ID"]).toMatch(HEX32);
    expect(captured.headers["X-Request-ID"]).toBe(captured.headers["X-Conversation-Request-ID"]);
    spy.mockRestore();
  });
});

describe("execute() integration", () => {
  it("uses SSE upstream even for a JSON client and includes the model correlation header", async () => {
    let captured;
    vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (_url, init) => {
      captured = init;
      return new Response('data: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    });
    await new CodeBuddyIntlExecutor().execute({
      model: "glm-5.2", body: { messages: [{ role: "user", content: "hello" }], stream: false },
      stream: false, credentials: CREDS,
    });
    expect(captured.headers.Accept).toBe("text/event-stream");
    expect(captured.headers["X-Model-ID"]).toBe("glm-5.2");
    expect(JSON.parse(captured.body).stream).toBe(true);
    expect(captured.headers["X-Request-ID"]).toBe(captured.headers["X-Conversation-Request-ID"]);
  });

  it("preserves case-insensitive model/request overrides without duplicate keys", async () => {
    let captured;
    vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (_url, init) => {
      captured = init;
      return new Response('data: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    });
    await new CodeBuddyIntlExecutor().execute({
      model: "glm-5.2", body: { messages: [{ role: "user", content: "hello" }] },
      stream: true, credentials: CREDS,
      providerOverrides: { headers: { "x-model-id": "explicit-model", "x-request-id": "explicit-request" } },
    });
    expect(keysMatching(captured.headers, "x-model-id")).toHaveLength(1);
    expect(captured.headers["x-model-id"]).toBe("explicit-model");
    expect(keysMatching(captured.headers, "x-request-id")).toHaveLength(1);
    expect(captured.headers["x-request-id"]).toBe("explicit-request");
  });

  it("sends the family and the normalised body upstream", async () => {
    const captured = {};
    const spy = vi.spyOn(proxyFetchModule, "proxyAwareFetch")
      .mockImplementation(async (url, init) => {
        captured.url = url;
        captured.headers = init.headers;
        captured.body = JSON.parse(init.body);
        return { ok: true, status: 200, headers: new Map() };
      });

    await new CodeBuddyIntlExecutor().execute({
      model: "glm-5.2",
      body: {
        messages: [
          { role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude." },
          { role: "user", content: "run the tests" },
        ],
      },
      stream: true,
      credentials: CREDS,
    });

    expect(captured.url).toBe(URL_);
    for (const name of CONVERSATION_HEADERS) expect(captured.headers[name], name).toBeTruthy();
    expect(captured.body.stream).toBe(true);
    expect(captured.body.messages[0].role).toBe("system");
    // The gateway rejects the leading identity sentence (live A/B), so it is
    // neutralised; the rest of the prompt is not asserted here — that is the
    // dedicated normalizeIntlMessages suite.
    expect(captured.body.messages[0].content).not.toMatch(/Claude Code, Anthropic/i);
    expect(captured.body.messages[1].content).toEqual([{ type: "text", text: "run the tests" }]);
    spy.mockRestore();
  });

  it("keeps the conversation id stable across a retry of the same execute call", async () => {
    const seen = [];
    const spy = vi.spyOn(proxyFetchModule, "proxyAwareFetch")
      .mockImplementation(async (url, init) => {
        seen.push(init.headers["X-Conversation-ID"]);
        return { ok: true, status: 200, headers: new Map() };
      });

    const executor = new CodeBuddyIntlExecutor();
    const args = {
      model: "glm-5.2",
      body: { messages: [{ role: "user", content: "same turn" }] },
      stream: true,
      credentials: CREDS,
    };
    await executor.execute(args);
    await executor.execute(args);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    spy.mockRestore();
  });
});

describe("normalizeIntlMessages preserves Claude Code instructions", () => {
  it("neutralises ONLY the opening identity line and keeps the rest", () => {
    const out = normalizeIntlMessages([
      {
        role: "system",
        content:
          "You are Claude Code, Anthropic's official CLI for Claude.\n\n"
          + "IMPORTANT: Assist with defensive security tasks only.\n\n"
          + "You are an interactive CLI tool that helps users with software engineering tasks.",
      },
      { role: "user", content: "hi" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe("system");
    expect(out[0].content).not.toMatch(/You are Claude Code, Anthropic/i);
    // The operating instructions survive verbatim.
    expect(out[0].content).toContain("Assist with defensive security tasks only.");
    expect(out[0].content).toContain("You are an interactive CLI tool");
  });

  it("keeps a system prompt that never mentions the Claude Code identity", () => {
    const text = "You are a coding assistant. Always run the tests before answering.";
    const out = normalizeIntlMessages([{ role: "system", content: text }, { role: "user", content: "hi" }]);
    expect(out[0].content).toBe(text);
  });

  it("folds a leading developer message into the system prompt", () => {
    const out = normalizeIntlMessages([
      { role: "developer", content: "Be terse." },
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "hi" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe("system");
    expect(out[0].content).toBe("Be terse.\n\nYou are a coding assistant.");
  });

  it("converts typed system blocks to text", () => {
    const out = normalizeIntlMessages([
      { role: "system", content: [{ type: "text", text: "block one" }, { type: "text", text: "block two" }] },
      { role: "user", content: "hi" },
    ]);
    expect(out[0].content).toBe("block one\nblock two");
  });

  it("prepends a neutral prompt when the request has no system turn", () => {
    const out = normalizeIntlMessages([{ role: "user", content: "hi" }]);
    expect(out[0]).toEqual({ role: "system", content: "You are CodeBuddy Code." });
    expect(out).toHaveLength(2);
  });

  it("converts string user content to typed blocks and leaves tool turns alone", () => {
    const toolCall = { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "run", arguments: "{}" } }] };
    const toolResult = { role: "tool", tool_call_id: "t1", content: "ok" };
    const out = normalizeIntlMessages([
      { role: "system", content: "s" },
      { role: "user", content: "do it" },
      toolCall,
      toolResult,
    ]);
    expect(out[1].content).toEqual([{ type: "text", text: "do it" }]);
    expect(out[2]).toEqual(toolCall);
    expect(out[3]).toEqual(toolResult);
  });

  it("does not hoist a mid-conversation system turn over the user turn", () => {
    // Hoisting would reorder instructions relative to the conversation they
    // belong to; the gateway only requires the FIRST message to be a system turn.
    const out = normalizeIntlMessages([
      { role: "system", content: "leading" },
      { role: "user", content: "first" },
      { role: "system", content: "reminder mid-conversation" },
      { role: "user", content: "second" },
    ]);
    expect(out[0].content).toBe("leading");
    expect(out.map((m) => m.role)).toEqual(["system", "user", "user", "user"]);
    expect(out[2].content).toEqual([{ type: "text", text: "reminder mid-conversation" }]);
  });

  it("is idempotent", () => {
    const once = normalizeIntlMessages([
      { role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude.\n\nKeep me." },
      { role: "user", content: "hi" },
    ]);
    const twice = normalizeIntlMessages(once);
    expect(twice).toEqual(once);
  });

  it("handles a missing or non-array messages field", () => {
    for (const input of [undefined, null, "nope", 42]) {
      const out = normalizeIntlMessages(input);
      expect(out).toEqual([{ role: "system", content: "You are CodeBuddy Code." }]);
    }
  });
});

// Live A/B against the real gateway (2026-10-17) pinned the trigger: the
// identity sentence is rejected only in the LEADING position. Every case below
// is a measured response, not an assumption.
describe("neutralizeIdentityPrompt matches the measured gateway behaviour", () => {
  it("rejects-by-neutralising the exact leading identity sentence", () => {
    const out = neutralizeIdentityPrompt("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(out).not.toMatch(/Claude Code, Anthropic/i);
    expect(out).toBe("You are a helpful AI assistant that helps with software engineering tasks.");
  });

  it("keeps the body after the identity line", () => {
    const out = neutralizeIdentityPrompt(
      "You are Claude Code, Anthropic's official CLI for Claude.\n\nYou are an interactive CLI tool.",
    );
    expect(out).not.toMatch(/Claude Code, Anthropic/i);
    expect(out).toContain("You are an interactive CLI tool.");
  });

  it("leaves a shorter identity phrase alone (measured 200 upstream)", () => {
    expect(neutralizeIdentityPrompt("You are Claude Code.")).toBe("You are Claude Code.");
  });

  it("leaves the comma-free variant alone (measured 200 upstream)", () => {
    const text = "You are Claude Code - Anthropic's official CLI for Claude.";
    expect(neutralizeIdentityPrompt(text)).toBe(text);
  });

  it("leaves 'You are Claude Code, an interactive CLI tool.' alone (measured 200)", () => {
    const text = "You are Claude Code, an interactive CLI tool.";
    expect(neutralizeIdentityPrompt(text)).toBe(text);
  });

  it("leaves the identity sentence alone when it is not leading (measured 200)", () => {
    const text = "You are an interactive CLI tool. You are Claude Code, Anthropic's official CLI for Claude.";
    expect(neutralizeIdentityPrompt(text)).toBe(text);
  });

  it("leaves unrelated prompts untouched", () => {
    for (const text of ["You are Claude.", "You are an interactive CLI tool built by Anthropic.", ""]) {
      expect(neutralizeIdentityPrompt(text)).toBe(text);
    }
  });

  it("handles non-string input", () => {
    for (const input of [undefined, null, 42, {}]) {
      expect(neutralizeIdentityPrompt(input)).toBe(input);
    }
  });
});

describe("parseError classifies every 400 variant", () => {
  const exec = new CodeBuddyIntlExecutor();
  const res = (status = 400) => ({ status });

  it("names channel verification for the conversation-id variant", () => {
    const out = exec.parseError(res(), JSON.stringify({
      code: 11128,
      msg: "conversation id missing",
      displayTips: { en: "This call failed channel verification" },
    }));
    expect(out.status).toBe(400);
    expect(out.message).toMatch(/channel verification/i);
    expect(out.message).toMatch(/X-Conversation/);
    expect(out.message).toContain("This call failed channel verification");
  });

  it("names channel verification for the live 2026-10-17 wording", () => {
    // Observed against the real gateway: the gate no longer says
    // "conversation id missing", it says "unapproved channel".
    const out = exec.parseError(res(), JSON.stringify({
      code: 11128,
      msg: "Illegal API invocation from an unapproved channel",
      displayMsg: { en: "Request blocked. Please send it again" },
    }));
    expect(out.status).toBe(400);
    expect(out.message).toMatch(/channel verification/i);
    expect(out.message).toContain("Illegal API invocation from an unapproved channel");
    expect(out.message).toContain("Request blocked");
  });

  it("does NOT claim channel verification for the system-prompt variant", () => {
    const out = exec.parseError(res(), JSON.stringify({
      code: 11128,
      msg: "first message is not system prompt",
    }));
    expect(out.message).not.toMatch(/channel verification/i);
    expect(out.message).toMatch(/system prompt/i);
    expect(out.message).toMatch(/normalizeIntlMessages/);
  });

  it("names an illegal request without inventing a channel gate", () => {
    const out = exec.parseError(res(), JSON.stringify({ code: 11103, msg: "request illegal" }));
    expect(out.status).toBe(400);
    expect(out.message).toMatch(/illegal/i);
    expect(out.message).not.toMatch(/channel verification/i);
  });

  it("maps 11102 model-not-found to 404 so the combo can fall through", () => {
    const out = exec.parseError(res(), JSON.stringify({ code: 11102, msg: "model service info not found" }));
    expect(out.status).toBe(404);
    expect(out.message).toMatch(/11102|not available/i);
  });

  it("explains the non-stream rejection", () => {
    const out = exec.parseError(res(), JSON.stringify({ code: 11101, msg: "Non-stream chat request is currently not supported" }));
    expect(out.status).toBe(400);
    expect(out.message).toMatch(/stream/i);
  });

  it("still maps the frequency-limit code to 429 with a reset time", () => {
    const out = exec.parseError(res(429), JSON.stringify({ code: 6004, msg: "超出频率限制 2026-10-16 10:00:00 UTC+8" }));
    expect(out.status).toBe(429);
    expect(out.resetsAtMs).toBe(new Date("2026-10-16T10:00:00+08:00").getTime());
  });

  it("falls back to the default parser for unknown codes and non-JSON bodies", () => {
    expect(exec.parseError(res(), JSON.stringify({ code: 9999, msg: "something else" })).message)
      .toBe(JSON.stringify({ code: 9999, msg: "something else" }));
    expect(exec.parseError(res(), "<html>nope</html>").message).toBe("<html>nope</html>");
  });
});

describe("Claude Code -> translator -> executor regression", () => {
  it("keeps the CLI system prompt and tool turns through the real OpenAI translation", async () => {
    const { translateRequest } = await import("../../open-sse/translator/index.js");
    const { FORMATS } = await import("../../open-sse/translator/formats.js");

    // Shaped like Claude Code's /v1/messages request.
    const claudeBody = {
      model: "glm-5.2",
      max_tokens: 4096,
      system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      messages: [
        { role: "user", content: [{ type: "text", text: "list the files" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt" }] },
      ],
      stream: true,
    };

    const translated = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.OPENAI,
      "glm-5.2",
      structuredClone(claudeBody),
      true,
      { accessToken: "t", connectionId: "c1" },
      "codebuddy-intl",
    );

    const out = new CodeBuddyIntlExecutor().transformRequest(
      "glm-5.2", translated, true, { accessToken: "t", connectionId: "c1" },
    );

    expect(out.messages[0].role).toBe("system");
    // Identity line neutralised (live-measured 400 upstream); the CLI's other
    // instructions are preserved by normalizeIntlMessages.
    expect(out.messages[0].content).not.toMatch(/Claude Code, Anthropic/i);
    expect(out.messages.some((m) => m.role === "assistant" && Array.isArray(m.tool_calls))).toBe(true);
    expect(out.messages.some((m) => m.role === "tool" && m.tool_call_id === "toolu_1")).toBe(true);
    expect(out.stream).toBe(true);
  });
});
