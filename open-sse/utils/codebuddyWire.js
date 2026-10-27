// IDE 4.12.1 factory 955691: request reasoning aliases and SSE wire repairs.
// ponytail: provider-local compatibility only; no SDK defaults or tool-output coercion.
export function normalizeCodeBuddyPayload(body, model = body.model || "") {
  const hasReasoning = message => [message?.reasoning, message?.reasoning_content].some(value => typeof value === "string" && value.trim());
  const thinkingEnabled = !!body.reasoning_effort || (body.thinking && body.thinking.type !== "disabled" && body.thinking.type !== false)
    || (typeof body.reasoning?.effort === "string" && !!body.reasoning.effort);
  // Exact conditions from IDE factory 955691; empty strings are not generated reasoning.
  const backfill = /deepseek|kimi/i.test(model) || /(?:^|[:/])mimo-v\d+(?:\.\d+)*(?:-[a-z0-9.-]+)?$/i.test(model)
    || (thinkingEnabled && Array.isArray(body.messages) && body.messages.some(message => message?.role === "assistant" && hasReasoning(message)));
  const messages = Array.isArray(body.messages) ? body.messages.map((message) => {
    if (message?.role !== "assistant") return message;
    const reasoning = typeof message.reasoning === "string" && message.reasoning.trim();
    const content = typeof message.reasoning_content === "string" && message.reasoning_content.trim();
    if (reasoning && !content) return { ...message, reasoning_content: message.reasoning };
    if (content && !reasoning) return { ...message, reasoning: message.reasoning_content };
    if (!content && !reasoning && backfill) return { ...message, reasoning: "", reasoning_content: "" };
    return message;
  }) : null;
  const result = { ...body, ...(messages ? { messages } : {}) };
  if (typeof result.reasoning_effort === "string" && result.reasoning_effort) delete result.reasoningEffort;
  return result;
}

const MAX_EVENT_CHARS = 4 * 1024 * 1024;

export function normalizeCodeBuddyEvent(payload, event = "") {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("CodeBuddy returned an invalid SSE payload");
  }
  if (event === "error" || payload.error || payload.choices?.some((choice) => choice?.finish_reason === "error")) {
    // Never echo arbitrary upstream payloads/prompts into logs or error terminals.
    throw new Error("CodeBuddy upstream stream failed");
  }
  const terminal = payload.done === true;
  const result = { ...payload };
  delete result.done; // Shared OpenAI parser treats done as a sentinel, discarding its payload.
  if (result.choices === null && result.usage != null) result.choices = [];
  if (Array.isArray(result.choices)) {
    result.choices = result.choices.map((choice) => {
      if (!Array.isArray(choice?.delta?.tool_calls)) return choice;
      return { ...choice, delta: { ...choice.delta, tool_calls: choice.delta.tool_calls.map((call) =>
        call?.type === "" ? { ...call, type: "function" } : call) } };
    });
  }
  return { payload: result, terminal };
}

// Pull, rather than start/pump: no eager draining or whole-response buffering.
export function normalizeCodeBuddyStream(response) {
  if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let data = [];
  let event = "";
  let eventChars = 0;
  let ended = false;
  let eof = false;
  let terminalPending = false;
  let skipLF = false;
  const cancel = (reason) => { void reader.cancel(reason).catch(() => {}); };
  const dispatch = () => {
    const text = data.join("\n");
    const eventName = event;
    data = []; event = ""; eventChars = 0;
    if (eventName === "error") throw new Error("CodeBuddy upstream stream failed");
    if (!text) return null;
    if (eventName) return null; // Match IDE SSEUtil: unnamed events/error only.
    if (text.trim() === "[DONE]") return { terminal: true, frame: "data: [DONE]\n\n" };
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error("CodeBuddy returned malformed SSE JSON"); }
    const normalized = normalizeCodeBuddyEvent(parsed, eventName);
    return { terminal: normalized.terminal, frame: `data: ${JSON.stringify(normalized.payload)}\n\n` };
  };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        if (terminalPending) {
          terminalPending = false;
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        while (!ended) {
          if (skipLF && buffer) {
            if (buffer.startsWith("\n")) buffer = buffer.slice(1);
            skipLF = false;
          }
          const newline = buffer.search(/[\r\n]/);
          if (newline >= 0) {
              const line = buffer.slice(0, newline);
              skipLF = buffer[newline] === "\r";
              buffer = buffer.slice(newline + 1);
              if (line.startsWith(":")) continue;
              if (!line) {
                const item = dispatch();
                if (!item) continue;
                controller.enqueue(encoder.encode(item.frame));
                if (item.terminal) {
                  ended = true;
                  buffer = "";
                  cancel();
                  if (item.frame === "data: [DONE]\n\n") controller.close();
                  else terminalPending = true;
                }
                return;
              }
              const colon = line.indexOf(":");
              const field = colon < 0 ? line : line.slice(0, colon);
              const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
              eventChars += line.length;
              if (eventChars > MAX_EVENT_CHARS) throw new Error("CodeBuddy SSE event exceeds size limit");
              if (field === "data") data.push(value);
              else if (field === "event") event = value;
              continue;
          }
          if (buffer.length + eventChars > MAX_EVENT_CHARS) throw new Error("CodeBuddy SSE event exceeds size limit");
          if (eof) throw new Error("CodeBuddy stream ended without a terminal event");
          const chunk = await reader.read();
          if (ended) return;
          eof = chunk.done;
          buffer += eof ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
          if (!eof && chunk.value?.byteLength) {
            // The shared stall watchdog sits downstream. Expose raw-byte activity
            // even while a multiline event is incomplete; never expose its data.
            controller.enqueue(encoder.encode(": keepalive\n\n"));
            return;
          }
        }
      } catch (error) {
        ended = true;
        cancel(error);
        controller.error(error);
      }
    },
    cancel(reason) { ended = true; cancel(reason); },
  }, { highWaterMark: 0 });
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
