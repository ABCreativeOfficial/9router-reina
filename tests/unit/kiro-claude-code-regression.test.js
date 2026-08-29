// Regression suite for the Claude Code + UltraClaude + MCP + Subagent → 9Router → Kiro path.
//
// Root cause covered here (decolua/9router #2989): a top-level `systemPrompt`
// field on the Kiro payload is rejected upstream with 400 "Improperly formed
// request" / REQUEST_BODY_INVALID. The same request *without* `system` succeeds
// — so `agentMode`, `agentContinuationId`, `agentTaskType`, `conversationId`
// and session replay are all valid; only the top-level system field is not.
// Also covered: the `[1m]` local model modifier must never reach Kiro's
// upstream model id (#1503).
import { describe, it, expect } from "vitest";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { resolveKiroModel, resolveKiroModelIntent } from "../../open-sse/config/kiroConstants.js";
import { openaiToKiroRequest } from "../../open-sse/translator/request/openai-to-kiro.js";
import { injectSystemPrompt } from "../../open-sse/rtk/systemInject.js";
import { validateKiroConversation } from "../../open-sse/translator/concerns/kiroConversation.js";

const C2K = (body, credentials = null, model = "claude-sonnet-4.5") =>
  translateRequest(FORMATS.CLAUDE, FORMATS.KIRO, model, body, true, credentials, "kiro");

const curOf = (out) => out.conversationState.currentMessage.userInputMessage;
const contentOf = (out) => curOf(out).content || "";
const wireText = (out) =>
  JSON.stringify(out.conversationState.history) + "\n" + contentOf(out);

const creds = (sid) => ({ rawHeaders: { "x-session-id": sid }, connectionId: "acct-1" });
let seq = 0;
const uniq = (base) => `${base}-${++seq}`;

// Assert the payload carries no field Kiro rejects upstream.
function assertNoInvalidTopLevel(out) {
  expect(out.systemPrompt).toBeUndefined();
  expect(out._frozenMsg0).toBeUndefined(); // internal marker must never leak
  expect(JSON.stringify(out)).not.toContain('"systemPrompt"');
}

// Assert the whole wire conversation satisfies Kiro's alternation/tool rules.
function assertWireValid(out, specs = []) {
  const v = validateKiroConversation(
    out.conversationState.history,
    out.conversationState.currentMessage,
    specs
  );
  expect(v.errors).toEqual([]);
  expect(v.valid).toBe(true);
}

describe("Kiro / Claude Code regression — system prompt (#2989)", () => {
  it("A: system prompt is preserved in content, never top-level systemPrompt", () => {
    const out = C2K({
      system: "You are a coding assistant.",
      messages: [{ role: "user", content: "hello" }],
    });
    assertNoInvalidTopLevel(out);
    expect(contentOf(out)).toContain("<instructions>");
    expect(contentOf(out)).toContain("You are a coding assistant.");
    expect(contentOf(out)).toContain("hello");
    assertWireValid(out);
  });

  it("B: request without system stays valid", () => {
    const out = C2K({ messages: [{ role: "user", content: "plain hello" }] });
    assertNoInvalidTopLevel(out);
    expect(contentOf(out)).toContain("plain hello");
    assertWireValid(out);
  });

  it("A2: array-form system blocks are folded into <instructions>", () => {
    const out = C2K({
      system: [{ type: "text", text: "First directive." }, { type: "text", text: "Second directive." }],
      messages: [{ role: "user", content: "go" }],
    });
    assertNoInvalidTopLevel(out);
    expect(contentOf(out)).toContain("First directive.");
    expect(contentOf(out)).toContain("Second directive.");
    assertWireValid(out);
  });
});

describe("Kiro / Claude Code regression — multi-turn & session replay", () => {
  it("C: user/assistant/user alternation stays valid", () => {
    const out = C2K({
      messages: [
        { role: "user", content: "turn one" },
        { role: "assistant", content: "answer one" },
        { role: "user", content: "turn two" },
      ],
    });
    assertNoInvalidTopLevel(out);
    assertWireValid(out);
    const roles = [...out.conversationState.history, out.conversationState.currentMessage].map((t) =>
      t.userInputMessage ? "user" : "assistant"
    );
    expect(roles).toEqual(["user", "assistant", "user"]);
  });

  // Real clients (Claude Code) resend the full message history AND the system
  // field on every turn, so the frozen msg0 (system + timestamp + first user
  // turn) is re-derived identically and replays verbatim as history[0].
  it("K: session continuation — frozen msg0 replays verbatim on later turns", () => {
    const c = creds(uniq("reg-cont"));
    const first = C2K({ system: "sys", messages: [{ role: "user", content: "first" }] }, c);
    // Turn 2/3 resend system + full prior history (Anthropic protocol).
    const second = C2K({
      system: "sys",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer-one" },
        { role: "user", content: "second" },
      ],
    }, c);
    const third = C2K({
      system: "sys",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer-one" },
        { role: "user", content: "second" },
        { role: "assistant", content: "answer-two" },
        { role: "user", content: "third" },
      ],
    }, c);

    for (const out of [first, second, third]) assertNoInvalidTopLevel(out);

    const frozen = first.conversationState.currentMessage.userInputMessage.content;
    // The frozen first turn replays verbatim as history[0] on every later turn.
    expect(second.conversationState.history[0].userInputMessage.content).toBe(frozen);
    expect(third.conversationState.history[0].userInputMessage.content).toBe(frozen);
    // Continuation id is stable across the session.
    expect(second.conversationState.agentContinuationId).toBe(first.conversationState.agentContinuationId);
    expect(third.conversationState.agentContinuationId).toBe(first.conversationState.agentContinuationId);
    assertWireValid(second);
    assertWireValid(third);
  });

  it("J: stable prefix is not lost, duplicated, or merged into the current turn", () => {
    const c = creds(uniq("reg-prefix"));
    const first = C2K({ system: "SYSMARKER", messages: [{ role: "user", content: "m1" }] }, c);
    const second = C2K({
      system: "SYSMARKER",
      messages: [
        { role: "user", content: "m1" },
        { role: "assistant", content: "r1" },
        { role: "user", content: "m2" },
      ],
    }, c);

    const replayed = second.conversationState.history[0].userInputMessage.content;
    const current = contentOf(second);
    // prefix present exactly once in the replayed msg0 ...
    expect(replayed.split("SYSMARKER").length - 1).toBe(1);
    // ... and the current turn does NOT carry the frozen msg0's user content.
    expect(current).not.toContain("m1");
    expect(current).toContain("m2");
    // msg0 was not merged into current (it replays the frozen first turn verbatim).
    expect(replayed).toBe(first.conversationState.currentMessage.userInputMessage.content);
  });

  it("M: subagent session isolation — two sessions never share history", () => {
    const sa = creds(uniq("sess-A"));
    const sb = creds(uniq("sess-B"));
    const a1 = C2K({ system: "AGENT-A", messages: [{ role: "user", content: "a-one" }] }, sa);
    const b1 = C2K({ system: "AGENT-B", messages: [{ role: "user", content: "b-one" }] }, sb);
    // Session A turn 2 resends its own system + prior history.
    const a2 = C2K({
      system: "AGENT-A",
      messages: [
        { role: "user", content: "a-one" },
        { role: "assistant", content: "a-reply" },
        { role: "user", content: "a-two" },
      ],
    }, sa);

    // Each session has its own conversationId and its own frozen msg0.
    expect(a1.conversationState.conversationId).not.toBe(b1.conversationState.conversationId);
    const aFrozen = a2.conversationState.history[0].userInputMessage.content;
    expect(aFrozen).toContain("AGENT-A");
    expect(aFrozen).toContain("a-one");
    expect(aFrozen).not.toContain("AGENT-B");
    expect(aFrozen).not.toContain("b-one");
    assertNoInvalidTopLevel(a2);
  });
});

describe("Kiro / Claude Code regression — thinking / agentic variants", () => {
  it("D: thinking variant injects tag in content, no top-level systemPrompt", () => {
    const out = C2K({ messages: [{ role: "user", content: "think" }] }, null, "claude-sonnet-4.5-thinking");
    assertNoInvalidTopLevel(out);
    expect(contentOf(out)).toContain("<thinking_mode>enabled</thinking_mode>");
    expect(curOf(out).modelId).toBe("claude-sonnet-4.5");
    assertWireValid(out);
  });

  it("E: agentic variant injects chunked-write protocol in content", () => {
    const out = C2K({ messages: [{ role: "user", content: "work" }] }, null, "claude-sonnet-4.5-agentic");
    assertNoInvalidTopLevel(out);
    expect(contentOf(out)).toContain("CHUNKED WRITE PROTOCOL");
    expect(curOf(out).modelId).toBe("claude-sonnet-4.5");
    assertWireValid(out);
  });

  it("F: thinking-agentic variant injects both prefixes in content", () => {
    const out = C2K({ messages: [{ role: "user", content: "think + act" }] }, null, "claude-sonnet-4.5-thinking-agentic");
    assertNoInvalidTopLevel(out);
    expect(contentOf(out)).toContain("<thinking_mode>enabled</thinking_mode>");
    expect(contentOf(out)).toContain("CHUNKED WRITE PROTOCOL");
    expect(curOf(out).modelId).toBe("claude-sonnet-4.5");
    assertWireValid(out);
  });

  // Kiro rejects "claude-sonnet-4.5-agentic" as an upstream id (400
  // INVALID_MODEL_ID), so both suffix orders must strip down to the base model.
  it("F2: reversed -agentic-thinking order resolves to the same upstream model", () => {
    const out = C2K({ messages: [{ role: "user", content: "think + act" }] }, null, "claude-sonnet-4.5-agentic-thinking");
    assertNoInvalidTopLevel(out);
    expect(curOf(out).modelId).toBe("claude-sonnet-4.5");
    expect(contentOf(out)).toContain("<thinking_mode>enabled</thinking_mode>");
    expect(contentOf(out)).toContain("CHUNKED WRITE PROTOCOL");
    assertWireValid(out);
  });

  it("F3: suffix stripping is order-insensitive in the resolver", () => {
    const both = { upstream: "claude-sonnet-4.5", agentic: true, thinking: true };
    expect(resolveKiroModel("claude-sonnet-4.5-thinking-agentic")).toEqual(both);
    expect(resolveKiroModel("claude-sonnet-4.5-agentic-thinking")).toEqual(both);
    expect(resolveKiroModel("claude-sonnet-4.5-agentic-thinking[1m]")).toEqual(both);
    expect(resolveKiroModel("claude-opus-4.8-agentic-thinking")).toEqual({
      upstream: "claude-opus-4.8",
      agentic: true,
      thinking: true,
    });
  });
});

describe("Kiro / Claude Code regression — [1m] modifier (#1503)", () => {
  it("G: [1m] is stripped, thinking-agentic suffixes still parsed", () => {
    const out = C2K(
      { messages: [{ role: "user", content: "big context" }] },
      null,
      "claude-sonnet-4.5-thinking-agentic[1m]"
    );
    assertNoInvalidTopLevel(out);
    expect(curOf(out).modelId).toBe("claude-sonnet-4.5");
    expect(contentOf(out)).toContain("<thinking_mode>enabled</thinking_mode>");
    expect(contentOf(out)).toContain("CHUNKED WRITE PROTOCOL");
    expect(JSON.stringify(out)).not.toContain("[1m]");
    assertWireValid(out);
  });

  it("G2: resolver strips bracket modifiers from the upstream id", () => {
    expect(resolveKiroModel("claude-sonnet-4.5-thinking-agentic[1m]")).toEqual({
      upstream: "claude-sonnet-4.5",
      agentic: true,
      thinking: true,
    });
    expect(resolveKiroModel("claude-sonnet-4.5[1m]")).toEqual({
      upstream: "claude-sonnet-4.5",
      agentic: false,
      thinking: false,
    });
    expect(resolveKiroModel("claude-opus-4.7-thinking-agentic[1m]")).toEqual({
      upstream: "claude-opus-4.7",
      agentic: true,
      thinking: true,
    });
    // plain models untouched
    expect(resolveKiroModel("claude-sonnet-4.5").upstream).toBe("claude-sonnet-4.5");
  });

  it("G3: intent resolution also strips bracket modifiers", () => {
    const intent = resolveKiroModelIntent("claude-sonnet-4.5-thinking-agentic[1m]");
    expect(intent.upstream).toBe("claude-sonnet-4.5");
    expect(intent.agentic).toBe(true);
    expect(intent.thinking).toBe(true);
  });
});

describe("Kiro / Claude Code regression — MCP / tools", () => {
  const weatherTool = {
    name: "get_weather",
    description: "Get weather for a city",
    input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  };

  it("H: tools + tool_use + tool_result pair stays structured and valid", () => {
    const out = C2K({
      tools: [weatherTool],
      messages: [
        { role: "user", content: "weather in NYC?" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "NYC" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "sunny 75F" }] },
      ],
    });
    assertNoInvalidTopLevel(out);
    // tool specs must be present on the current message context
    const specs = curOf(out).userInputMessageContext?.tools || [];
    expect(specs.length).toBe(1);
    // tool_use in history with matching structured tool_result on the current turn
    const assistant = out.conversationState.history.find((h) => h.assistantResponseMessage?.toolUses);
    expect(assistant.assistantResponseMessage.toolUses[0].name).toBe("get_weather");
    const results = curOf(out).userInputMessageContext?.toolResults || [];
    expect(results.length).toBe(1);
    expect(results[0].toolUseId).toBe(assistant.assistantResponseMessage.toolUses[0].toolUseId);
    expect(results[0].content[0].text).toContain("sunny 75F");
    assertWireValid(out, specs);
  });

  it("L: continuation after a tool_result keeps the conversation valid", () => {
    const out = C2K({
      tools: [weatherTool],
      messages: [
        { role: "user", content: "run tool" },
        { role: "assistant", content: [{ type: "tool_use", id: "t9", name: "get_weather", input: { city: "LA" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: "done" }] },
        { role: "assistant", content: "The weather tool finished." },
        { role: "user", content: "thanks, summarize" },
      ],
    });
    assertNoInvalidTopLevel(out);
    assertWireValid(out, curOf(out).userInputMessageContext?.tools || []);
    expect(contentOf(out)).toContain("summarize");
  });

  it("I: many MCP tools (30) produce a valid payload", () => {
    const tools = Array.from({ length: 30 }, (_, i) => ({
      name: `mcp_tool_${i}`,
      description: `Tool number ${i} for doing thing ${i}`,
      input_schema: {
        type: "object",
        properties: { arg: { type: "string" }, n: { type: "number" } },
        required: ["arg"],
      },
    }));
    const out = C2K({ tools, messages: [{ role: "user", content: "use your tools" }] });
    assertNoInvalidTopLevel(out);
    const specs = curOf(out).userInputMessageContext?.tools || [];
    expect(specs.length).toBe(30);
    // every spec has a normalized name + object schema
    for (const s of specs) {
      expect(s.toolSpecification.name).toBeTruthy();
      expect(s.toolSpecification.inputSchema.json.type).toBe("object");
    }
    assertWireValid(out, specs);
  });

  it("N: MCP double-underscore names survive both translator paths", () => {
    const mcp = {
      name: "mcp__server__tool",
      description: "An MCP tool",
      input_schema: { type: "object", properties: { arg: { type: "string" } } },
    };
    const out = C2K({ tools: [mcp], messages: [{ role: "user", content: "call it" }] });
    assertNoInvalidTopLevel(out);
    expect(JSON.stringify(out)).toContain("mcp__server__tool");

    const o2k = openaiToKiroRequest("claude-sonnet-4.5", {
      messages: [{ role: "user", content: "call it" }],
      tools: [{ type: "function", function: { name: "mcp__server__tool", parameters: mcp.input_schema } }],
    }, true, {});
    expect(o2k.systemPrompt).toBeUndefined();
    expect(JSON.stringify(o2k)).toContain("mcp__server__tool");
  });
});

// The token savers run AFTER translation, on the already-built Kiro payload
// (chatCore: injectCaveman/injectPonytail with finalFormat === "kiro"). Upstream's
// injector mirrors the prompt into a top-level `systemPrompt`; on this fork that
// field must never be created, or #2989 returns through the back door.
describe("Kiro / Claude Code regression — post-translation system injection (#2989)", () => {
  const MODELS = [
    "claude-sonnet-4.5-thinking",
    "claude-sonnet-4.5-agentic",
    "claude-sonnet-4.5-thinking-agentic",
    "claude-sonnet-4.5-agentic-thinking",
  ];

  it.each(MODELS)("%s survives injectSystemPrompt with no top-level systemPrompt", (model) => {
    const out = C2K(
      { system: "SYSTEM_MARKER", messages: [{ role: "user", content: "hi" }] },
      creds(uniq("inject")),
      model
    );
    assertNoInvalidTopLevel(out);

    injectSystemPrompt(out, FORMATS.KIRO, "SAVER_MARKER");

    // field still absent — the prompt travels inside user content instead
    assertNoInvalidTopLevel(out);
    const first = out.conversationState.history.find((h) => h?.userInputMessage)?.userInputMessage
      ?? curOf(out);
    expect(first.content).toContain("SAVER_MARKER");
    expect(first.content).toContain("SYSTEM_MARKER");
    expect(curOf(out).modelId).toBe("claude-sonnet-4.5");
    assertWireValid(out);
  });
});
