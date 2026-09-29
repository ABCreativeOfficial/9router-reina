import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  saveUsageStats: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { convertResponsesStreamToJson, classifyResponsesTerminalState } = await import("../../open-sse/transformer/streamToJsonConverter.js");

const encoder = new TextEncoder();

/** Build a Responses-API SSE stream from [eventName, payload] pairs. */
function responsesSSE(events) {
  const text = events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

const sseResponse = (events, headers = {}) => new Response(responsesSSE(events), {
  status: 200,
  headers: { "Content-Type": "text/event-stream", ...headers },
});

/** Minimal Responses SSE that reaches a successful terminal event. */
const completedTextEvents = (text = "hello") => [
  ["response.created", { response: { id: "resp_test_1", created_at: 1700000000 } }],
  ["response.output_item.done", {
    output_index: 0,
    item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  }],
  ["response.completed", { response: { id: "resp_test_1", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }],
];

const completedToolEvents = () => [
  ["response.created", { response: { id: "resp_tool_1", created_at: 1700000000 } }],
  ["response.output_item.done", {
    output_index: 0,
    item: { type: "function_call", call_id: "call_1", name: "shell", arguments: "{\"cmd\":\"ls\"}" },
  }],
  ["response.completed", { response: { id: "resp_tool_1", usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } } }],
];

/** Invoke the forced-SSE→JSON handler the way chatCore does for codex + claude. */
async function runForcedSseToJson({ providerResponse, sourceFormat = FORMATS.CLAUDE, targetFormat = FORMATS.OPENAI_RESPONSES, provider = "codex" }) {
  return handleForcedSSEToJson({
    providerResponse,
    sourceFormat,
    targetFormat,
    provider,
    model: "gpt-6-sol",
    body: { model: "codex/gpt-6-sol", stream: false },
    stream: false,
    translatedBody: null,
    finalBody: null,
    requestStartTime: Date.now(),
    connectionId: "fixture",
    apiKey: "fixture-key",
    clientRawRequest: { endpoint: "/v1/messages" },
    onRequestSuccess: vi.fn(async () => {}),
    customToolNames: null,
    toolNameMap: null,
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    reqTag: "",
    log: { warn: vi.fn(), line: vi.fn(), debug: vi.fn() },
  });
}

describe("Codex forceStream + Claude stream=false (regression)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns an Anthropic Message, not a chat.completion or Responses object", async () => {
    const result = await runForcedSseToJson({ providerResponse: sseResponse(completedTextEvents()) });

    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("content-type")).toContain("application/json");

    const body = await result.response.json();
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(Array.isArray(body.content)).toBe(true);
    expect(body.content).toEqual([{ type: "text", text: "hello" }]);
    // The exact shapes that broke Claude Code must be absent.
    expect(body.object).toBeUndefined();
    expect(body.choices).toBeUndefined();
    expect(body.output).toBeUndefined();
    expect(body.stop_reason).toBe("end_turn");
    expect(body.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("keeps tool calls as Anthropic tool_use blocks", async () => {
    const result = await runForcedSseToJson({ providerResponse: sseResponse(completedToolEvents()) });
    const body = await result.response.json();

    expect(body.type).toBe("message");
    expect(body.content).toEqual([
      { type: "tool_use", id: "call_1", name: "shell", input: { cmd: "ls" } },
    ]);
    expect(body.stop_reason).toBe("tool_use");
    // A tool-calling turn must not degrade into text or OpenAI tool_calls.
    expect(body.choices).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("tool_calls");
  });

  it("does not leak SSE framing into the JSON body", async () => {
    const result = await runForcedSseToJson({ providerResponse: sseResponse(completedTextEvents()) });
    const raw = await result.response.text();

    expect(raw).not.toContain("data:");
    expect(raw).not.toContain("[DONE]");
    expect(raw).not.toContain("event:");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe("incomplete or failed Responses streams are not success", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a stream that ends before response.completed", async () => {
    const events = [
      ["response.created", { response: { id: "resp_stall" } }],
      ["response.output_item.done", {
        output_index: 0,
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "partial" }] },
      }],
      // stream ends here: no response.completed
    ];
    const result = await runForcedSseToJson({ providerResponse: sseResponse(events) });

    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    const body = await result.response.json();
    expect(body.error?.message || body.error).toMatch(/Incomplete Responses stream/);
  });

  it("rejects response.failed", async () => {
    const events = [
      ["response.created", { response: { id: "resp_failed" } }],
      ["response.failed", { response: { id: "resp_failed", status: "failed" } }],
    ];
    const result = await runForcedSseToJson({ providerResponse: sseResponse(events) });

    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    expect(await result.response.text()).not.toContain('"type":"message"');
  });

  it("rejects response.cancelled", async () => {
    const events = [
      ["response.created", { response: { id: "resp_cancel" } }],
      ["response.cancelled", { response: { id: "resp_cancel" } }],
    ];
    const result = await runForcedSseToJson({ providerResponse: sseResponse(events) });
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
  });

  it("rejects response.incomplete", async () => {
    const events = [
      ["response.created", { response: { id: "resp_incomplete" } }],
      ["response.incomplete", { response: { id: "resp_incomplete" } }],
    ];
    const result = await runForcedSseToJson({ providerResponse: sseResponse(events) });
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
  });

  it("classifies terminal states directly", () => {
    expect(classifyResponsesTerminalState({ status: "completed" }).ok).toBe(true);
    expect(classifyResponsesTerminalState({ status: "done" }).ok).toBe(true);
    for (const status of ["in_progress", "failed", "cancelled", "incomplete", undefined]) {
      expect(classifyResponsesTerminalState({ status }).ok, String(status)).toBe(false);
    }
  });

  it("reports an in_progress status when the stream simply ends", async () => {
    const converted = await convertResponsesStreamToJson(responsesSSE([
      ["response.created", { response: { id: "resp_x" } }],
    ]));
    expect(converted.status).toBe("in_progress");
    expect(classifyResponsesTerminalState(converted).ok).toBe(false);
  });
});

describe("non-Claude clients keep their existing shapes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("still returns a Responses object for a Responses client", async () => {
    const result = await runForcedSseToJson({
      providerResponse: sseResponse(completedTextEvents()),
      sourceFormat: FORMATS.OPENAI_RESPONSES,
    });
    const body = await result.response.json();

    expect(result.success).toBe(true);
    expect(body.object).toBe("response");
    expect(body.type).toBeUndefined();
    expect(Array.isArray(body.output)).toBe(true);
  });

  it("still returns a chat.completion for an OpenAI client", async () => {
    const result = await runForcedSseToJson({
      providerResponse: sseResponse(completedTextEvents()),
      sourceFormat: FORMATS.OPENAI,
    });
    const body = await result.response.json();

    expect(result.success).toBe(true);
    expect(body.object).toBe("chat.completion");
    expect(body.type).toBeUndefined();
    expect(body.choices[0].message.content).toBe("hello");
  });

  it("still returns a Gemini-shaped body for a Gemini client", async () => {
    const result = await runForcedSseToJson({
      providerResponse: sseResponse(completedTextEvents()),
      sourceFormat: FORMATS.GEMINI,
    });
    const body = await result.response.json();

    expect(result.success).toBe(true);
    expect(body.response?.candidates?.[0]?.content?.parts?.[0]?.text).toBe("hello");
  });
});

describe("error status propagation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("never serializes a failed conversion as a 200", async () => {
    const events = [["response.created", { response: { id: "resp_e" } }]];
    const result = await runForcedSseToJson({ providerResponse: sseResponse(events) });

    expect(result.success).toBe(false);
    expect(result.response).toBeInstanceOf(Response);
    expect(result.response.status).toBeGreaterThanOrEqual(400);
  });
});
