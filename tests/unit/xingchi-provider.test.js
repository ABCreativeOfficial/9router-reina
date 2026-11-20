import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { parseModel } from "../../open-sse/services/model.js";
import { getTargetFormat } from "../../open-sse/services/provider.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { CODEX_CLI_VERSION } from "../../open-sse/config/codexModels.js";

describe("Xingchi API-key Responses provider", () => {
  it("is registered as an API-key provider with streaming Responses transport", () => {
    const entry = REGISTRY.find((item) => item.id === "xingchi");
    expect(entry).toMatchObject({
      alias: "xc",
      category: "apikey",
      authType: "apikey",
      passthroughModels: true,
    });
    expect(PROVIDERS.xingchi).toMatchObject({
      baseUrl: "https://api.xingchiapi.com/v1/responses",
      validateUrl: "https://api.xingchiapi.com/v1/models",
      format: "openai-responses",
      forceStream: true,
      headers: { "x-openai-actor-authorization": "local-image-extension" },
      quirks: { disableResponseStorage: true },
    });
    expect(PROVIDERS.xingchi.headers?.originator).toBe("codex_cli_rs");
    expect(getTargetFormat("xingchi")).toBe("openai-responses");
  });

  it("resolves the short alias without rewriting upstream model ids", () => {
    expect(parseModel("xc/gpt-6.1-sol")).toMatchObject({
      provider: "xingchi",
      model: "gpt-6.1-sol",
    });
    expect(PROVIDER_MODELS.xc).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gpt-6.1-sol" }),
    ]));
  });

  it("sends only standard API-key headers to the streaming Responses endpoint", () => {
    const executor = new DefaultExecutor("xingchi");
    expect(executor.buildUrl("gpt-6.1-sol", true)).toBe("https://api.xingchiapi.com/v1/responses");
    const headers = executor.buildHeaders({ apiKey: "test-key" }, true);
    expect(headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
      Accept: "text/event-stream",
      "x-openai-actor-authorization": "local-image-extension",
    });
    expect(headers.originator).toBe("codex_cli_rs");
    expect(headers["User-Agent"]).toBe(`codex_cli_rs/${CODEX_CLI_VERSION}`);
    expect(headers.version).toBe(CODEX_CLI_VERSION);
  });

  it("enforces stateless Responses without mutating the incoming request", () => {
    const executor = new DefaultExecutor("xingchi");
    const body = { model: "gpt-6.1-sol", input: "hello", store: true, stream: true };
    const transformed = executor.transformRequest("gpt-6.1-sol", body, true, { apiKey: "test-key" });
    expect(transformed.store).toBe(false);
    expect(body.store).toBe(true);
    const other = new DefaultExecutor("openai");
    expect(other.transformRequest("gpt-5.5", { ...body }, true, { apiKey: "test-key" }).store).toBe(true);
  });
});
