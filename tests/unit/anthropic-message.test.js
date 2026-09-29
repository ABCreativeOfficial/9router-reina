import { describe, expect, it } from "vitest";
import {
  chatCompletionToAnthropicMessage,
  ensureAnthropicMessage,
  hasAssistantOutput,
  isAnthropicMessage,
} from "../../open-sse/translator/concerns/anthropicMessage.js";

const openAIBody = (overrides = {}) => ({
  id: "chatcmpl-abc",
  model: "gpt-6-sol",
  choices: [{
    index: 0,
    message: { role: "assistant", content: "hello" },
    finish_reason: "stop",
  }],
  usage: { prompt_tokens: 12, completion_tokens: 3 },
  ...overrides,
});

describe("Anthropic Message validation", () => {
  it("accepts a well-formed message", () => {
    const message = chatCompletionToAnthropicMessage(openAIBody());
    expect(isAnthropicMessage(message)).toBe(true);
  });

  it("accepts a tool-use turn with no text (tool use is not a degraded response)", () => {
    const body = openAIBody({
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "t1", function: { name: "read_file", arguments: '{"path":"a"}' } }],
        },
        finish_reason: "tool_calls",
      }],
    });
    const message = chatCompletionToAnthropicMessage(body);

    expect(isAnthropicMessage(message)).toBe(true);
    expect(message.content).toEqual([
      { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
    ]);
    expect(message.stop_reason).toBe("tool_use");
    expect(hasAssistantOutput(message)).toBe(true);
  });

  it("rejects bodies that are not a message", () => {
    for (const bad of [null, undefined, {}, { type: "message" }, { type: "message", role: "assistant" }, { type: "message", role: "user", content: [] }, { error: { message: "boom" } }, []]) {
      expect(isAnthropicMessage(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("rejects a content array holding non-block entries", () => {
    expect(isAnthropicMessage({ type: "message", role: "assistant", content: ["nope"] })).toBe(false);
    expect(isAnthropicMessage({ type: "message", role: "assistant", content: [null] })).toBe(false);
  });

  it("does not report output for an empty text block", () => {
    const message = chatCompletionToAnthropicMessage(openAIBody({
      choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    }));
    expect(message.content).toEqual([{ type: "text", text: "" }]);
    expect(hasAssistantOutput(message)).toBe(false);
  });
});

describe("ensureAnthropicMessage", () => {
  it("passes a valid message through unchanged", () => {
    const message = chatCompletionToAnthropicMessage(openAIBody());
    const result = ensureAnthropicMessage(message);
    expect(result.ok).toBe(true);
    expect(result.message).toBe(message);
  });

  it("converts a Chat Completions body instead of failing the request", () => {
    const result = ensureAnthropicMessage(openAIBody());
    expect(result.ok).toBe(true);
    expect(result.message.type).toBe("message");
    expect(result.message.role).toBe("assistant");
    expect(result.message.content).toEqual([{ type: "text", text: "hello" }]);
    expect(result.message.stop_reason).toBe("end_turn");
    expect(result.message.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
    // The Anthropic id must not keep the OpenAI prefix.
    expect(result.message.id).toBe("abc");
  });

  it("carries reasoning into a thinking block only when asked", () => {
    const body = openAIBody({
      choices: [{
        index: 0,
        message: { role: "assistant", content: "answer", reasoning_content: "because" },
        finish_reason: "stop",
      }],
    });
    expect(ensureAnthropicMessage(body).message.content).toEqual([{ type: "text", text: "answer" }]);
    expect(ensureAnthropicMessage(body, { includeThinking: true }).message.content).toEqual([
      { type: "thinking", thinking: "because" },
      { type: "text", text: "answer" },
    ]);
  });

  it("maps finish reasons to Anthropic stop reasons", () => {
    const withFinish = (finish) => ensureAnthropicMessage(openAIBody({
      choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: finish }],
    })).message.stop_reason;
    expect(withFinish("stop")).toBe("end_turn");
    expect(withFinish("length")).toBe("max_tokens");
    expect(withFinish("tool_calls")).toBe("tool_use");
  });

  it("fails with a reason when the body is unusable", () => {
    const result = ensureAnthropicMessage({ error: { message: "upstream exploded" } });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not a valid Anthropic Message/);
  });

  it("tolerates malformed tool arguments without throwing", () => {
    const body = openAIBody({
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "t1", function: { name: "f", arguments: "{not json" } }],
        },
        finish_reason: "tool_calls",
      }],
    });
    const message = ensureAnthropicMessage(body).message;
    expect(message.content[0]).toMatchObject({ type: "tool_use", name: "f", input: {} });
  });
});
