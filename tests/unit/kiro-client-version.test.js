import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KIRO_IDE_VERSION,
  KIRO_CLI_VERSION,
  buildKiroCliUserAgent,
  buildKiroIdeHeaders,
  finalizeKiroIdeHeaders,
  getKiroMachineId,
} from "../../open-sse/config/kiroClientIdentity.js";
import { KiroExecutor } from "../../open-sse/executors/kiro.js";
import { resolveKiroModels, clearKiroModelCache } from "../../open-sse/services/kiroModels.js";
vi.mock("../../src/lib/oauth/constants/oauth.js", () => ({
  KIRO_CONFIG: {},
  assertValidAwsRegion: () => {},
}));
import { KiroService } from "../../src/lib/oauth/services/kiro.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  clearKiroModelCache();
  vi.restoreAllMocks();
});

describe("Kiro current client identity", () => {
  it("tracks official IDE and CLI versions independently", () => {
    expect(KIRO_IDE_VERSION).toBe("1.4.236");
    expect(KIRO_CLI_VERSION).toBe("3.5.0");
    expect(buildKiroCliUserAgent()).toBe("kiro-cli/3.5.0");
  });

  it("uses a stable hashed account fingerprint without exposing secrets", () => {
    const credentials = { accessToken: "my-sensitive-access-token" };
    const first = buildKiroIdeHeaders(credentials);
    const second = buildKiroIdeHeaders(credentials);
    expect(first).toEqual(second);
    expect(getKiroMachineId(credentials)).toMatch(/^[a-f0-9]{64}$/);
    expect(first["User-Agent"]).toContain(`KiroIDE-${KIRO_IDE_VERSION}-`);
    expect(first["User-Agent"]).toContain("api/codewhispererruntime#1.0.0");
    expect(JSON.stringify(first)).not.toContain(credentials.accessToken);
    expect(first["X-Amz-User-Agent"]).toContain(getKiroMachineId(credentials));
  });

  it("keeps streaming and model-catalog versions synchronized", () => {
    const credentials = { accessToken: "local-test-key", providerSpecificData: { authMethod: "api_key" } };
    const executor = new KiroExecutor();
    const inference = executor.buildHeaders(credentials, true, "https://q.us-east-1.amazonaws.com/generateAssistantResponse");
    const catalog = buildKiroIdeHeaders(credentials);
    expect(inference["User-Agent"]).toContain("api/codewhispererstreaming#1.0.0");
    expect(inference["X-Amz-User-Agent"]).toBe(catalog["X-Amz-User-Agent"]);
    expect(inference["x-amzn-codewhisperer-machine-id"]).toBe(getKiroMachineId(credentials));
    expect(inference.TokenType).toBe("API_KEY");
  });

  it("drops old Kiro overrides and mixed-case duplicates after override merge", () => {
    const credentials = { accessToken: "local-test-token" };
    const executor = new KiroExecutor();
    const headers = executor.buildHeaders(credentials);
    const overrides = {
      "user-agent": "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0",
      "x-amz-user-agent": "aws-sdk-js/1.0.0 KiroIDE-0.10.32-old",
    };
    const final = executor.finalizeHeaders({ ...headers, ...overrides }, { credentials, providerOverrides: { headers: overrides } });
    expect(Object.keys(final).filter((name) => name.toLowerCase() === "user-agent")).toHaveLength(1);
    expect(Object.keys(final).filter((name) => name.toLowerCase() === "x-amz-user-agent")).toHaveLength(1);
    expect(final["User-Agent"]).toContain(`KiroIDE-${KIRO_IDE_VERSION}-`);
    expect(final["X-Amz-User-Agent"]).not.toContain("0.10.32");
  });

  it("preserves deliberate up-to-date custom identity overrides", () => {
    const custom = "aws-sdk-js/1.0.0 KiroIDE-1.4.236-custom";
    const final = finalizeKiroIdeHeaders({ "x-amz-user-agent": custom }, {}, "codewhispererruntime", { "x-amz-user-agent": custom });
    expect(final["X-Amz-User-Agent"]).toBe(custom);
  });

  it("validates an API key using the live versioned catalog identity", async () => {
    const mock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [{ modelId: "auto" }] }) });
    global.fetch = mock;
    await new KiroService().validateApiKey("test-api-key");
    const [, request] = mock.mock.calls[0];
    expect(request.headers.TokenType).toBe("API_KEY");
    expect(request.headers["User-Agent"]).toContain(`KiroIDE-${KIRO_IDE_VERSION}-`);
  });

  it("adds TokenType and current identity to auto-discovered API-key models", async () => {
    const mock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [{ modelId: "auto", modelName: "Auto" }] }) });
    global.fetch = mock;
    const result = await resolveKiroModels({ accessToken: "test-api-key", providerSpecificData: { authMethod: "api_key" } });
    expect(result.models.some((m) => m.id === "auto")).toBe(true);
    const [, request] = mock.mock.calls[0];
    expect(request.headers.TokenType).toBe("API_KEY");
    expect(request.headers["User-Agent"]).toContain(`KiroIDE-${KIRO_IDE_VERSION}-`);
  });
});
