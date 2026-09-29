/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 */

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg.trim()) return;

  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  const dataMatch = msg.match(/^data:\s*(.+)$/m);
  if (!eventMatch || !dataMatch) return;

  const eventType = eventMatch[1].trim();
  const dataStr = dataMatch[1].trim();
  if (dataStr === "[DONE]") return;

  let parsed;
  try { parsed = JSON.parse(dataStr); }
  catch { return; }

  if (eventType === "response.created") {
    state.responseId = parsed.response?.id || state.responseId;
    state.created = parsed.response?.created_at || state.created;
  } else if (eventType === "response.output_item.done") {
    state.items.set(parsed.output_index ?? 0, parsed.item);
  } else if (eventType === "response.completed" || eventType === "response.done") {
    state.status = "completed";
    if (parsed.response?.usage) {
      state.usage.input_tokens = parsed.response.usage.input_tokens || 0;
      state.usage.output_tokens = parsed.response.usage.output_tokens || 0;
      state.usage.total_tokens = parsed.response.usage.total_tokens || 0;
    }
  } else if (eventType === "response.failed") {
    state.status = "failed";
  } else if (eventType === "response.cancelled" || eventType === "response.canceled") {
    state.status = "cancelled";
  } else if (eventType === "response.incomplete") {
    // A truncated turn (e.g. max_output_tokens) is not a completed one.
    state.status = "incomplete";
  }
}

const EMPTY_RESPONSE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

/** Terminal states a Responses stream can end on. */
export const RESPONSES_TERMINAL_COMPLETED = "completed";
export const RESPONSES_TERMINAL_DONE = "done";
const RESPONSES_TERMINAL_FAILURES = ["failed", "cancelled", "canceled", "incomplete"];

/**
 * Did this converted Responses stream actually reach a successful terminal event?
 *
 * A stream that ends before `response.completed` leaves the status at
 * `in_progress`, and one that carries `response.failed` / `response.cancelled` /
 * `response.incomplete` sets a failure status. Neither is a success: returning
 * them as HTTP 200 would hand the client a body that claims a completed turn.
 *
 * @param {object} result - output of convertResponsesStreamToJson
 * @returns {{ ok: boolean, status: string, reason: string|null }}
 */
export function classifyResponsesTerminalState(result) {
  const status = String(result?.status || "").trim().toLowerCase() || "unknown";
  if (status === RESPONSES_TERMINAL_COMPLETED || status === RESPONSES_TERMINAL_DONE) {
    return { ok: true, status, reason: null };
  }
  if (RESPONSES_TERMINAL_FAILURES.includes(status)) {
    return { ok: false, status, reason: `Upstream Responses stream ended with status "${status}"` };
  }
  return {
    ok: false,
    status,
    reason: `Incomplete Responses stream: no terminal response.completed event (status "${status}")`,
  };
}

/**
 * Convert Responses API SSE stream to single JSON response
 * @param {ReadableStream} stream - SSE stream from provider
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream) {
  if (!stream || typeof stream.getReader !== "function") {
    return { id: `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "failed", output: [], usage: { ...EMPTY_RESPONSE } };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const state = {
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    status: "in_progress",
    usage: { ...EMPTY_RESPONSE },
    items: new Map()
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";

      for (const msg of messages) {
        processSSEMessage(msg, state);
      }
    }

    // Flush remaining buffer (last event may not end with \n\n)
    if (buffer.trim()) {
      processSSEMessage(buffer, state);
    }
  } finally {
    reader.releaseLock();
  }

  // Build output array from accumulated items (ordered by index)
  const output = [];
  const maxIndex = state.items.size > 0 ? Math.max(...state.items.keys()) : -1;
  for (let i = 0; i <= maxIndex; i++) {
    output.push(state.items.get(i) || { type: "message", content: [], role: "assistant" });
  }

  return {
    id: state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    status: state.status || "completed",
    output,
    usage: state.usage
  };
}
