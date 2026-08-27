import { describe, expect, it } from "vitest";
import {
  NEW_API_FAMILY,
  buildNewApiConnectionData,
  deriveNewApiInferenceBaseUrl,
  getNewApiNodeOrigin,
  isNewApiConnection,
  isNewApiNode,
  isValidNewApiAlias,
  normalizeNewApiOrigin,
  readNewApiConnectionConfig,
  suggestNewApiAlias,
} from "../../open-sse/services/newapi/definition.js";

const NODE = Object.freeze({
  id: "openai-compatible-chat-abc",
  type: "openai-compatible",
  apiType: "chat",
  family: NEW_API_FAMILY,
  name: "Example API",
  prefix: "ex",
  baseUrl: "https://example.com/v1",
  newApi: { origin: "https://example.com" },
});

describe("New API origin validation", () => {
  it("accepts a bare https origin and canonicalizes it", () => {
    for (const [input, expected] of [
      ["https://example.com", "https://example.com"],
      ["https://api.example.com", "https://api.example.com"],
      // A trailing slash is only URL normalization, not a path.
      ["https://example.com/", "https://example.com"],
      ["  https://example.com  ", "https://example.com"],
      ["https://example.com:8443", "https://example.com:8443"],
    ]) {
      const result = normalizeNewApiOrigin(input);
      expect(result.ok, input).toBe(true);
      expect(result.origin).toBe(expected);
    }
  });

  it("rejects anything that could smuggle a different target", () => {
    for (const bad of [
      "http://example.com",
      "https://example.com/v1",
      "https://example.com/foo",
      "https://user:pass@example.com",
      "https://example.com?x=1",
      "https://example.com/#x",
      "ftp://example.com",
      "not-a-url",
      "",
      null,
      undefined,
    ]) {
      const result = normalizeNewApiOrigin(bad);
      expect(result.ok, String(bad)).toBe(false);
      expect(result.error).toBeTypeOf("string");
    }
  });

  it("derives the inference base URL so the user never types /v1", () => {
    expect(deriveNewApiInferenceBaseUrl("https://example.com")).toBe("https://example.com/v1");
    expect(deriveNewApiInferenceBaseUrl("https://example.com/")).toBe("https://example.com/v1");
  });
});

describe("New API alias rules", () => {
  it("accepts a safe lowercase model-id prefix", () => {
    for (const alias of ["ex", "gor", "tbt", "a1", "my-api"]) {
      expect(isValidNewApiAlias(alias), alias).toBe(true);
    }
  });

  it("rejects an unsafe prefix", () => {
    for (const alias of ["", "-lead", "UPPER", "has space", "has/slash", "x".repeat(33), null]) {
      expect(isValidNewApiAlias(alias), String(alias)).toBe(false);
    }
  });

  it("suggests a slug from a display name", () => {
    expect(suggestNewApiAlias("Example API")).toBe("example-api");
    expect(suggestNewApiAlias("TabiToken")).toBe("tabitoken");
    expect(suggestNewApiAlias("!!!")).toBe("");
  });
});

describe("New API definition recognition", () => {
  it("recognizes a node by family plus a valid origin, never by id", () => {
    expect(isNewApiNode(NODE)).toBe(true);
    expect(getNewApiNodeOrigin(NODE)).toBe("https://example.com");

    // Family without a usable origin is not a New API provider.
    expect(isNewApiNode({ ...NODE, newApi: { origin: "http://example.com" } })).toBe(false);
    expect(isNewApiNode({ ...NODE, newApi: undefined })).toBe(false);
    // An ordinary compatible node is untouched by the family layer.
    expect(isNewApiNode({ ...NODE, family: undefined })).toBe(false);
    expect(getNewApiNodeOrigin({ ...NODE, family: undefined })).toBe("");
    expect(isNewApiNode(null)).toBe(false);
  });

  it("builds the connection data a provider-agnostic layer needs", () => {
    expect(buildNewApiConnectionData(NODE)).toEqual({
      prefix: "ex",
      apiType: "chat",
      baseUrl: "https://example.com/v1",
      nodeName: "Example API",
      newApiOrigin: "https://example.com",
      newApiLabel: "Example API",
    });
    expect(buildNewApiConnectionData({ ...NODE, family: undefined })).toBeNull();
  });

  it("recognizes a connection by its own stored origin, never by provider id", () => {
    const connection = {
      provider: "openai-compatible-chat-abc",
      providerSpecificData: buildNewApiConnectionData(NODE),
    };
    expect(isNewApiConnection(connection)).toBe(true);
    expect(readNewApiConnectionConfig(connection)).toEqual({
      origin: "https://example.com",
      label: "Example API",
    });

    // A plain compatible connection must not be mistaken for New API.
    expect(isNewApiConnection({
      provider: "openai-compatible-chat-abc",
      providerSpecificData: { baseUrl: "https://example.com/v1" },
    })).toBe(false);
    // An http origin is not usable even if the marker is present.
    expect(isNewApiConnection({
      providerSpecificData: { newApiOrigin: "http://example.com" },
    })).toBe(false);
    expect(isNewApiConnection({})).toBe(false);
  });

  it("falls back to a generic label rather than an empty one", () => {
    const config = readNewApiConnectionConfig({
      providerSpecificData: { newApiOrigin: "https://example.com", newApiLabel: "   " },
    });
    expect(config).toEqual({ origin: "https://example.com", label: "New API" });
  });
});
