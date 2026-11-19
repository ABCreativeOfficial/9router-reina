import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseCodexCatalog,
  registerCodexCatalogModels,
  resolveCodexLiveModels,
} from "../../open-sse/services/codexModelDiscovery.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getProviderModels } from "../../open-sse/config/providerModels.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { parseCodexModelReference } from "../../open-sse/config/codexModels.js";
import * as transport from "../../open-sse/utils/proxyFetch.js";

const slug = "gpt-7.9-nebula";
const visible = {
  slug,
  display_name: "GPT-7.9-Nebula",
  visibility: "list",
  supported_in_api: true,
  default_reasoning_level: "medium",
  supported_reasoning_levels: [
    { effort: "low" }, { effort: "medium" }, { effort: "high" },
    { effort: "xhigh" }, { effort: "max" },
  ],
  context_window: 500000,
  max_context_window: 872000,
  max_output_tokens: 64000,
  input_modalities: ["text", "image"],
  use_responses_lite: true,
  service_tiers: [{ id: "priority", name: "Fast" }],
};

afterEach(() => vi.restoreAllMocks());

describe("Codex live catalog and automatic model registration", () => {
  it("filters hidden and non-API models, retaining official per-model metadata", () => {
    const catalog = parseCodexCatalog({ models: [
      visible,
      { ...visible, slug: "gpt-hidden", visibility: "hide" },
      { ...visible, slug: "gpt-not-api", supported_in_api: false },
      { ...visible, slug: "gpt-invalid!" },
    ] });

    expect(catalog).toHaveLength(1);
    expect(catalog[0].caps).toMatchObject({
      defaultReasoning: "medium", reasoning: ["low", "medium", "high", "xhigh", "max"],
      responsesLite: true, fast: true, contextWindow: 500000, extendedContext: true,
      maxOutput: 64000, vision: true,
    });
  });

  it("publishes future models and aliases, then routes Lite without manual edits", () => {
    registerCodexCatalogModels(parseCodexCatalog({ models: [visible] }));
    const ids = getProviderModels("cx").map((model) => model.id);
    expect(ids).toContain(slug);
    expect(ids).toContain(`${slug}-high-(fast)`);
    expect(ids).toContain(`${slug}[1m]`);
    expect(ids).not.toContain(`${slug}-ultra`);
    expect(parseCodexModelReference(`${slug}-high`).model).toBe(slug);
    expect(getThinkingLevels("codex", slug)).toContain("max");
    expect(getThinkingLevels("codex", slug)).not.toContain("ultra");
    expect(getCapabilitiesForModel("codex", slug).contextWindow).toBe(500000);
    expect(getCapabilitiesForModel("codex", `${slug}[1m]`).contextWindow).toBe(872000);

    const out = new CodexExecutor().transformRequest(`${slug}-high`, {
      model: `${slug}-high`, input: "hello", reasoning: { effort: "auto" },
    }, true, { connectionId: "new-model" });
    expect(out.model).toBe(slug);
    expect(out.reasoning).toMatchObject({ effort: "high", context: "all_turns" });
    expect(out.input[0].type).toBe("additional_tools");
    expect(out.tools).toBeNull();

    // A second successful fetch must refresh, not duplicate, aliases.
    registerCodexCatalogModels(parseCodexCatalog({ models: [visible] }));
    expect(getProviderModels("cx").filter((model) => model.id === `${slug}-high`)).toHaveLength(1);
  });

  it("fetches per account, reuses cached results, and passes account headers", async () => {
    const fetch = vi.spyOn(transport, "proxyAwareFetch").mockResolvedValue(
      Response.json({ models: [visible] }),
    );
    const credentials = {
      accessToken: "synthetic-token-7.9",
      connectionId: "live-discovery-7.9",
      providerSpecificData: { chatgptAccountId: "account-test-7.9" },
    };
    const [first, second] = await Promise.all([
      resolveCodexLiveModels(credentials),
      resolveCodexLiveModels(credentials),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first.models.some((model) => model.id === slug)).toBe(true);
    expect(second.models).toEqual(first.models);
    expect(fetch.mock.calls[0][0]).toContain("/codex/models?client_version=");
    expect(fetch.mock.calls[0][1].headers["ChatGPT-Account-ID"]).toBe("account-test-7.9");
    await resolveCodexLiveModels(credentials);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("discovers an unknown GPT before its first outbound Responses request", async () => {
    const future = "gpt-7.8-first-request";
    const calls = [];
    vi.spyOn(transport, "proxyAwareFetch").mockImplementation(async (url, options) => {
      calls.push({ url, options });
      if (url.includes("/codex/models?")) {
        return Response.json({ models: [{ ...visible, slug: future }] });
      }
      return new Response("event: response.completed\ndata: {}\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    });
    await new CodexExecutor().execute({
      model: `${future}-high`,
      body: { model: `${future}-high`, input: "hello", reasoning: { effort: "auto" } },
      stream: true,
      credentials: { accessToken: "future-test-token", connectionId: "future-test-connection" },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("/codex/models?");
    expect(calls[1].url).toContain("/codex/responses");
    const outbound = JSON.parse(calls[1].options.body);
    expect(outbound.model).toBe(future);
    expect(outbound.reasoning).toMatchObject({ effort: "high", context: "all_turns" });
    expect(outbound.tools).toBeNull();
    expect(calls[1].options.headers["x-openai-internal-codex-responses-lite"]).toBe("true");
  });

  it("fails open when the remote catalog is unavailable", async () => {
    vi.spyOn(transport, "proxyAwareFetch").mockResolvedValue(
      new Response("service unavailable", { status: 503 }),
    );
    const result = await resolveCodexLiveModels({
      accessToken: "another-test-token",
      connectionId: "failed-discovery-503",
    });
    expect(result.models).toEqual([]);
    expect(result.warning).toMatch(/503/);
    expect(getProviderModels("cx").some((model) => model.id === "gpt-6.2-sol")).toBe(true);
  });
});
