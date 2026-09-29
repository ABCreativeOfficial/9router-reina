/**
 * Anthropic Message assembly + validation.
 *
 * `/v1/messages` clients (Claude Code) require a strict success shape:
 *   HTTP 200 · Content-Type: application/json · one Anthropic Message object
 * with `type: "message"`, `role: "assistant"` and an array `content`.
 *
 * Every non-streaming path that can answer a Claude-format client funnels
 * through here, so a Chat Completions body, an SSE-tainted body or an empty
 * upstream 200 can never be handed back as if it were a valid Message.
 */
import { fromOpenAIFinish } from "./finishReason.js";
import { FORMATS } from "../formats.js";
import { ROLE, CLAUDE_BLOCK, RESPONSES_ITEM, CLAUDE_STOP } from "../schema/index.js";

/** Parse a tool-call arguments value into an object without throwing. */
function parseToolArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Convert an OpenAI Chat Completions body into an Anthropic Message.
 *
 * Reasoning becomes a `thinking` block (only when the caller opts in — a
 * `thinking` block is not valid for every client/format), assistant text
 * becomes a `text` block, and `tool_calls` become `tool_use` blocks: tool use
 * must stay valid, it is not a degraded response.
 *
 * @param {object} responseBody - OpenAI Chat Completions shaped body
 * @param {object} [options]
 * @param {boolean} [options.includeThinking] - emit a `thinking` block for reasoning_content
 * @returns {object|null} Anthropic Message, or null when the input is unusable
 */
export function chatCompletionToAnthropicMessage(responseBody, { includeThinking = false } = {}) {
  const choice = responseBody?.choices?.[0];
  if (!choice) return null;

  const message = choice.message || {};
  const content = [];

  const reasoning = message.reasoning_content || message.provider_specific_fields?.reasoning_content || "";
  if (includeThinking && typeof reasoning === "string" && reasoning.length > 0) {
    content.push({ type: CLAUDE_BLOCK.THINKING, thinking: reasoning });
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: CLAUDE_BLOCK.TEXT, text: message.content });
  }
  for (const toolCall of message.tool_calls || []) {
    const fn = toolCall.function || {};
    content.push({
      type: CLAUDE_BLOCK.TOOL_USE,
      id: toolCall.id || `toolu_${Date.now()}_${content.length}`,
      name: fn.name || toolCall.name || "",
      input: parseToolArguments(fn.arguments ?? toolCall.arguments),
    });
  }
  // An Anthropic Message always carries at least one block. A reasoning-only or
  // tool-only turn keeps its block; an otherwise empty turn becomes empty text.
  if (content.length === 0) content.push({ type: CLAUDE_BLOCK.TEXT, text: "" });

  const usage = responseBody.usage || {};
  return {
    id: String(responseBody.id || `msg_${Date.now()}`).replace(/^chatcmpl-/, ""),
    type: "message",
    role: ROLE.ASSISTANT,
    model: responseBody.model || "unknown",
    content,
    stop_reason: fromOpenAIFinish(choice.finish_reason, FORMATS.CLAUDE),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    },
  };
}

/**
 * Is this a structurally valid Anthropic Message a client can consume?
 * Deliberately shape-only: a tool-use turn with no text is valid, and an empty
 * text block is valid, so callers do not reject legitimate responses.
 */
export function isAnthropicMessage(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (body.type !== "message") return false;
  if (body.role !== ROLE.ASSISTANT) return false;
  if (!Array.isArray(body.content)) return false;
  return body.content.every((block) => block && typeof block === "object" && typeof block.type === "string");
}

/**
 * Does this body carry usable assistant output (text, thinking or tool use)?
 * Used to tell a real answer from an upstream 200 that contains nothing.
 */
export function hasAssistantOutput(message) {
  if (!Array.isArray(message?.content)) return false;
  return message.content.some((block) => {
    if (!block || typeof block !== "object") return false;
    if (block.type === CLAUDE_BLOCK.TEXT) return typeof block.text === "string" && block.text.length > 0;
    if (block.type === CLAUDE_BLOCK.THINKING) return typeof block.thinking === "string" && block.thinking.length > 0;
    if (block.type === CLAUDE_BLOCK.TOOL_USE) return typeof block.name === "string" && block.name.length > 0;
    return true;
  });
}

/**
 * Ensure a Claude-format non-streaming body is a valid Anthropic Message.
 *
 * @param {object} body - candidate body (already translated for the client format)
 * @param {object} [options]
 * @param {boolean} [options.includeThinking] - allow a thinking block when converting
 * @returns {{ ok: true, message: object } | { ok: false, reason: string }}
 */
export function ensureAnthropicMessage(body, { includeThinking = false } = {}) {
  if (isAnthropicMessage(body)) return { ok: true, message: body };

  // A Chat Completions body (the common case: the provider answered in OpenAI
  // shape and the client speaks Claude) is converted rather than rejected.
  const converted = chatCompletionToAnthropicMessage(body, { includeThinking });
  if (converted) return { ok: true, message: converted };

  return { ok: false, reason: "Upstream returned a response that is not a valid Anthropic Message" };
}

/** Concatenate the text of an Anthropic Message's text blocks (for logging). */
export function anthropicTextContent(message) {
  if (!Array.isArray(message?.content)) return null;
  const text = message.content
    .filter((block) => block?.type === CLAUDE_BLOCK.TEXT && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  return text.length > 0 ? text : null;
}

/**
 * Build an Anthropic Message from a Responses-API body.
 *
 * Used when a Codex/Responses upstream had to be streamed for a client that
 * asked for JSON: the Responses `output` array is the semantic source, so text
 * becomes `text` blocks and `function_call` items become `tool_use` blocks.
 * Tool use must stay valid — a tool-calling turn is a normal turn, not a
 * degraded response.
 *
 * @param {object} responsesBody - Responses API body ({ output: [...] })
 * @param {object} [options]
 * @param {boolean} [options.includeThinking] - emit a `thinking` block for reasoning summary text
 * @returns {object|null} Anthropic Message, or null when nothing usable was found
 */
export function responsesToAnthropicMessage(responsesBody, { includeThinking = false } = {}) {
  const output = responsesBody?.output;
  if (!Array.isArray(output)) return null;

  const content = [];
  let sawReasoning = false;
  let sawMessage = false;
  let sawToolCall = false;

  for (const item of output) {
    if (!item || typeof item !== "object") continue;

    if (item.type === RESPONSES_ITEM.REASONING) {
      const summaryText = Array.isArray(item.summary)
        ? item.summary.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
        : "";
      if (includeThinking && summaryText.length > 0) {
        content.push({ type: CLAUDE_BLOCK.THINKING, thinking: summaryText });
      }
      sawReasoning = true;
      continue;
    }

    if (item.type === RESPONSES_ITEM.MESSAGE) {
      sawMessage = true;
      const text = Array.isArray(item.content)
        ? item.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
        : "";
      if (text.length > 0) content.push({ type: CLAUDE_BLOCK.TEXT, text });
      continue;
    }

    if (item.type === RESPONSES_ITEM.FUNCTION_CALL) {
      sawToolCall = true;
      content.push({
        type: CLAUDE_BLOCK.TOOL_USE,
        id: item.call_id || item.id || `toolu_${content.length}`,
        name: item.name || "",
        input: parseToolArguments(item.arguments),
      });
      continue;
    }

    // Custom (freeform) tool calls carry a raw string input, not JSON arguments.
    if (item.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL) {
      sawToolCall = true;
      content.push({
        type: CLAUDE_BLOCK.TOOL_USE,
        id: item.call_id || item.id || `toolu_${content.length}`,
        name: item.name || "",
        input: typeof item.input === "string" ? { input: item.input } : (item.input || {}),
      });
    }
  }

  if (!sawMessage && !sawToolCall && !sawReasoning) return null;

  // A completed turn always carries at least one block; a reasoning-only turn
  // that the caller did not want as a thinking block becomes empty text.
  if (content.length === 0) content.push({ type: CLAUDE_BLOCK.TEXT, text: "" });

  const usage = responsesBody.usage || {};
  const status = String(responsesBody.status || "").toLowerCase();
  const stopReason = sawToolCall
    ? CLAUDE_STOP.TOOL_USE
    : (status === "incomplete" ? CLAUDE_STOP.MAX_TOKENS : CLAUDE_STOP.END_TURN);

  return {
    id: String(responsesBody.id || `msg_${Date.now()}`).replace(/^resp_/, ""),
    type: "message",
    role: ROLE.ASSISTANT,
    model: responsesBody.model || "unknown",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
    },
  };
}

/**
 * Responses body → validated Anthropic Message, or null when it cannot be built.
 * Wraps responsesToAnthropicMessage so callers get a single shape to check.
 */
export function buildClaudeMessageFromResponses(responsesBody, options) {
  const message = responsesToAnthropicMessage(responsesBody, options);
  return isAnthropicMessage(message) ? message : null;
}
