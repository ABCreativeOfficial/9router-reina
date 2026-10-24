// Combo rotation must keep working across the CodeBuddy Intl classifications.
//
// A request-scoped 400 (malformed body) says nothing about the next model, and a
// provider-scoped block says nothing about a *different provider* in the combo.
// Before this change the 11128 block fell into the request-scoped catch-all and
// ended the combo on the first member; that is the combo half of #5024/#5041.
import { describe, expect, it, vi } from "vitest";

import { handleComboChat } from "../../open-sse/services/combo.js";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
const executor = new CodeBuddyIntlExecutor();

const parse = (body, status = 400) => executor.parseError({ status }, JSON.stringify(body));

// Mirrors handleSingleModelChat's failure contract: a Response carrying the
// classified message in the OpenAI error envelope.
function failure(parsed) {
  return new Response(JSON.stringify({ error: { message: parsed.message } }), {
    status: parsed.status,
    headers: { "Content-Type": "application/json" },
  });
}

const success = (text) => new Response(JSON.stringify({
  choices: [{ message: { content: text }, finish_reason: "stop" }],
}), { status: 200, headers: { "Content-Type": "application/json" } });

const body = { messages: [{ role: "user", content: "hi" }] };

describe("combo advances past CodeBuddy Intl failures", () => {
  it("advances past an account restriction (11140)", async () => {
    const restricted = parse({ code: 11140, msg: "Your account has been restricted due to unusual activity" }, 403);
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(failure(restricted))
      .mockResolvedValueOnce(success("from the second member"));

    const result = await handleComboChat({
      body,
      models: ["cbai/glm-5.2", "cbai/deepseek-v4.1-flash"],
      handleSingleModel,
      log,
      comboName: "cbai-combo",
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ choices: [{ message: { content: "from the second member" } }] });
  });

  it("advances past a channel-verification block (11128)", async () => {
    const blocked = parse({
      code: 11128,
      msg: "request illegal",
      displayTips: { en: "This call failed channel verification" },
    });
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(failure(blocked))
      .mockResolvedValueOnce(success("next member answered"));

    const result = await handleComboChat({
      body,
      models: ["cbai/glm-5.2", "cbai/deepseek-v4.1-flash"],
      handleSingleModel,
      log,
      comboName: "cbai-combo",
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(200);
  });

  it("advances past a request-scoped body error and returns its own 400 when every member rejects", async () => {
    // A request-scoped 400 says this member cannot serve THIS body, not that the
    // account is unhealthy: members run on different providers with different
    // validation, so the next member may serve it (upstream 5cdcddf5). With every
    // member rejecting, the first member's own response is handed back.
    const requestScoped = parse({ code: 11128, msg: "first message is not system prompt" });
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(failure(requestScoped))
      .mockResolvedValueOnce(failure(requestScoped));

    const result = await handleComboChat({
      body,
      models: ["cbai/glm-5.2", "cbai/deepseek-v4.1-flash"],
      handleSingleModel,
      log,
      comboName: "cbai-combo",
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ error: { message: expect.stringMatching(/system prompt/i) } });
  });
});
