/**
 * Kiro wire-protocol regression tests.
 *
 * Every assertion below is derived from the shipped Kiro IDE 1.5.11 extension
 * bundle (`resources/app/extensions/kiro.kiro-agent/dist/extension.js`), whose
 * `@amzn/kiro-runtime-service-typescript-client` descriptor and awsJson1_0
 * protocol implementation define the runtime surface:
 *
 *   - `protocolSettings.defaultNamespace = "com.amazon.kiro.runtimeservice"`
 *   - `version = "2026-01-13"`, `serviceTarget = "KiroRuntimeService"`
 *   - `protocol = AwsJson1_0Protocol` -> `content-type: application/x-amz-json-1.0`
 *   - `x-amz-target: ${serviceTarget}.${commandName}`
 *     => `KiroRuntimeService.GenerateAssistantResponse`
 *   - `serializeRequest` appends a trailing slash to the modeled path
 *     => `POST /generateAssistantResponse/`
 *
 * and the separate `@aws/codewhisperer-streaming-client`, which is restJson
 * (`serviceTarget: AmazonCodeWhispererStreamingService`, no target header).
 */
import { describe, expect, it } from "vitest";
import {
  KIRO_CODEWHISPERER_TARGET,
  KIRO_RUNTIME_TARGET,
  KIRO_RUNTIME_JSON_CONTENT_TYPE,
  canonicalKiroUrl,
  isKiroRuntimeSurface,
} from "../../open-sse/config/kiroConstants.js";
import { KiroExecutor } from "../../open-sse/executors/kiro.js";

const RUNTIME = "https://runtime.us-east-1.kiro.dev/generateAssistantResponse";
const Q = "https://q.us-east-1.amazonaws.com/generateAssistantResponse";
const CODEWHISPERER = "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse";

function credentials(authMethod = "builder-id") {
  return { accessToken: "test-token", providerSpecificData: { authMethod } };
}

describe("Kiro runtime surface identification", () => {
  it("treats only runtime.*.kiro.dev as the awsJson surface", () => {
    expect(isKiroRuntimeSurface(RUNTIME)).toBe(true);
    expect(isKiroRuntimeSurface("https://runtime.eu-central-1.kiro.dev/")).toBe(true);
    expect(isKiroRuntimeSurface(Q)).toBe(false);
    expect(isKiroRuntimeSurface(CODEWHISPERER)).toBe(false);
    expect(isKiroRuntimeSurface("https://runtime.us-east-1.kiro.dev.evil.tld/")).toBe(false);
  });

  it("appends the serializer's trailing slash only to the runtime path", () => {
    expect(canonicalKiroUrl(RUNTIME)).toBe(`${RUNTIME}/`);
    expect(canonicalKiroUrl(`${RUNTIME}/`)).toBe(`${RUNTIME}/`);
    expect(canonicalKiroUrl(Q)).toBe(Q);
    expect(canonicalKiroUrl(CODEWHISPERER)).toBe(CODEWHISPERER);
  });
});

describe("Kiro per-surface protocol headers", () => {
  const executor = new KiroExecutor();

  it("uses the awsJson1_0 KiroRuntimeService target on the runtime host", () => {
    const headers = executor.buildHeaders(credentials(), true, RUNTIME);
    expect(headers["X-Amz-Target"]).toBe(KIRO_RUNTIME_TARGET);
    expect(headers["X-Amz-Target"]).toBe("KiroRuntimeService.GenerateAssistantResponse");
    expect(headers["Content-Type"]).toBe(KIRO_RUNTIME_JSON_CONTENT_TYPE);
    expect(headers["Content-Type"]).toBe("application/x-amz-json-1.0");
  });

  it("never sends the CodeWhisperer target to the runtime host", () => {
    // The restJson serviceTarget is not a valid awsJson target; emitting it on
    // the runtime surface is the exact mismatch this test guards.
    const headers = executor.buildHeaders(credentials(), true, RUNTIME);
    expect(headers["X-Amz-Target"]).not.toBe(KIRO_CODEWHISPERER_TARGET);
  });

  it("keeps the CodeWhisperer restJson host on its own target", () => {
    const headers = executor.buildHeaders(credentials(), true, CODEWHISPERER);
    expect(headers["X-Amz-Target"]).toBe(KIRO_CODEWHISPERER_TARGET);
    // restJson carries JSON, not the awsJson envelope content type.
    expect(headers["Content-Type"]).not.toBe(KIRO_RUNTIME_JSON_CONTENT_TYPE);
  });

  it("sends no target header to Amazon Q", () => {
    const headers = executor.buildHeaders(credentials(), true, Q);
    expect(headers["X-Amz-Target"]).toBeUndefined();
    expect(headers["Content-Type"]).not.toBe(KIRO_RUNTIME_JSON_CONTENT_TYPE);
  });

  it("keeps credential-derived identity headers on every surface", () => {
    const creds = credentials("api_key");
    for (const url of [RUNTIME, Q, CODEWHISPERER]) {
      const headers = executor.buildHeaders(creds, true, url);
      expect(headers.TokenType).toBe("API_KEY");
      expect(headers.Authorization).toBe("Bearer test-token");
      expect(headers["x-amzn-kiro-agent-mode"]).toBeTruthy();
      expect(headers["User-Agent"]).toContain("api/codewhispererstreaming#");
    }
  });
});

describe("Kiro request URL shape", () => {
  const executor = new KiroExecutor();

  it("addresses the runtime surface at the awsJson path with a trailing slash", () => {
    // runtime is last in every ordered set, so it is the final fallback index.
    const last = executor.getFallbackCount() - 1;
    expect(executor.buildUrl("claude-sonnet-4.5", true, last, credentials())).toBe(
      `${RUNTIME}/`
    );
  });

  it("leaves the first (Amazon Q) surface path unchanged", () => {
    expect(executor.buildUrl("claude-sonnet-4.5", true, 0, credentials())).toBe(Q);
  });
});