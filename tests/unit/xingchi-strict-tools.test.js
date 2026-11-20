import { describe, expect, it } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";
import { forceNonStrictResponsesFunctionTools } from "../../open-sse/utils/responsesToolSchemas.js";

const model = "gpt-6.1-sol";
const credentials = { apiKey: "test-only" };
const notSchema = {
  type: "object",
  properties: {
    query: { type: "string", not: { enum: ["disallowed"] } },
    not: { type: "string" }, // A property *named* not is valid too.
  },
  required: ["query"],
};

describe("Xingchi Responses non-strict Claude Code tools", () => {
  it("preserves all 274 tools and a `not` schema at index 100 across Claude → Responses", () => {
    const claude = {
      model,
      messages: [{ role: "user", content: "Use the tools" }],
      tools: Array.from({ length: 274 }, (_, i) => ({
        name: `tool_${i}`,
        description: `Tool ${i}`,
        input_schema: i === 100 ? notSchema : { type: "object", properties: {} },
      })),
    };

    const openai = claudeToOpenAIRequest(model, claude, true, credentials);
    const responses = openaiToOpenAIResponsesRequest(model, openai, true, credentials);
    expect(responses.tools).toHaveLength(274);
    expect(responses.tools[100].strict).toBeUndefined();

    const sent = new DefaultExecutor("xingchi").transformRequest(model, responses, true, credentials);
    expect(sent.tools).toHaveLength(274);
    expect(sent.tools[100]).toMatchObject({
      name: "tool_100",
      strict: false,
      parameters: notSchema,
    });
    expect(sent.tools.every((tool) => tool.strict === false)).toBe(true);
    expect(sent.store).toBe(false);
    // The original request and its schema must remain intact for retries.
    expect(responses.tools[100].strict).toBeUndefined();
    expect(claude.tools[100].input_schema).toEqual(notSchema);
  });

  it("forces both missing and strict:true functions to non-strict only for Xingchi", () => {
    const tools = [
      { type: "function", name: "missing", parameters: notSchema },
      { type: "function", name: "strict_true", strict: true, parameters: notSchema },
      { type: "function", name: "already_false", strict: false, parameters: notSchema },
      { type: "web_search_preview", search_context_size: "medium" },
    ];
    const input = { model, input: "test", tools, store: true };
    const xingchi = new DefaultExecutor("xingchi").transformRequest(model, input, true, credentials);
    expect(xingchi.tools.map((tool) => tool.strict)).toEqual([false, false, false, undefined]);
    expect(xingchi.tools[3]).toBe(tools[3]);
    expect(xingchi.tools[1].parameters).toBe(notSchema);
    expect(tools[0].strict).toBeUndefined();
    expect(tools[1].strict).toBe(true);

    const other = new DefaultExecutor("openai").transformRequest(model, input, true, credentials);
    expect(other.tools).toEqual(tools);
    expect(other.store).toBe(true);
  });

  it("normalizes namespace functions without mutating them or hosted tools", () => {
    const namespace = {
      type: "namespace",
      name: "mcp",
      tools: [
        { type: "function", name: "nested", parameters: notSchema },
        { type: "function", name: "nested_true", strict: true, parameters: notSchema },
        { type: "web_search" },
      ],
    };
    const body = { tools: [namespace], model };
    const sent = forceNonStrictResponsesFunctionTools(body);
    expect(sent.tools[0].tools.map((tool) => tool.strict)).toEqual([false, false, undefined]);
    expect(sent.tools[0].tools[0].parameters.properties.query.not).toEqual({ enum: ["disallowed"] });
    expect(namespace.tools[0].strict).toBeUndefined();
    expect(namespace.tools[1].strict).toBe(true);
    expect(sent.tools[0].tools[2]).toBe(namespace.tools[2]);
    expect(forceNonStrictResponsesFunctionTools(sent)).toBe(sent);
  });

  it("keeps empty/malformed tools and tool-free requests untouched", () => {
    expect(forceNonStrictResponsesFunctionTools(null)).toBeNull();
    const noTools = { model, input: "hello" };
    expect(forceNonStrictResponsesFunctionTools(noTools)).toBe(noTools);
    const malformed = { tools: [null, "bad", 42, { type: "function", name: "ok" }] };
    const result = forceNonStrictResponsesFunctionTools(malformed);
    expect(result.tools).toEqual([null, "bad", 42, { type: "function", name: "ok", strict: false }]);
  });
});
