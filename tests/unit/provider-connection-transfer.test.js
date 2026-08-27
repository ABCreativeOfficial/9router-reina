import { describe, it, expect } from "vitest";
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  serializeConnectionForExport,
  buildExportPayload,
  buildExportFilename,
  validateImportPayload,
  prepareConnectionForImport,
  connectionIdentityKey,
  redactConnection,
} from "@/lib/providerConnectionTransfer";

const oauthConn = {
  id: "db-id-1",
  provider: "codex",
  authType: "oauth",
  name: "Work",
  email: "a@example.com",
  accessToken: "at-1",
  refreshToken: "rt-1",
  idToken: "it-1",
  expiresAt: "2030-01-01T00:00:00.000Z",
  tokenType: "Bearer",
  scope: "openid",
  defaultModel: "gpt-5.5",
  isActive: true,
  priority: 3,
  createdAt: "2020-01-01T00:00:00.000Z",
  updatedAt: "2020-01-02T00:00:00.000Z",
  testStatus: "active",
  lastError: "boom",
  rateLimitedUntil: "2020-01-03T00:00:00.000Z",
  consecutiveUseCount: 9,
  providerSpecificData: {
    chatgptAccountId: "ws-1",
    enabledModels: ["gpt-5.5", "sol"],
    proxyPoolId: "pool-1",
    somethingCustom: { nested: true },
  },
};

describe("serializeConnectionForExport", () => {
  it("keeps credentials and drops server-controlled/transient fields", () => {
    const out = serializeConnectionForExport(oauthConn);
    expect(out.accessToken).toBe("at-1");
    expect(out.refreshToken).toBe("rt-1");
    expect(out.idToken).toBe("it-1");
    expect(out.expiresAt).toBe("2030-01-01T00:00:00.000Z");
    for (const f of ["id", "provider", "createdAt", "updatedAt", "priority", "testStatus", "lastError", "rateLimitedUntil", "consecutiveUseCount"]) {
      expect(out).not.toHaveProperty(f);
    }
  });

  it("keeps providerSpecificData including enabledModels and unknown keys", () => {
    const out = serializeConnectionForExport(oauthConn);
    expect(out.providerSpecificData.enabledModels).toEqual(["gpt-5.5", "sol"]);
    expect(out.providerSpecificData.somethingCustom).toEqual({ nested: true });
  });

  it("copies unknown top-level custom fields rather than dropping them", () => {
    const out = serializeConnectionForExport({ ...oauthConn, futureField: "keep-me" });
    expect(out.futureField).toBe("keep-me");
  });

  it("returns null for a non-object", () => {
    expect(serializeConnectionForExport(null)).toBeNull();
    expect(serializeConnectionForExport([])).toBeNull();
  });
});

describe("buildExportPayload / filename", () => {
  it("stamps format, version and provider", () => {
    const payload = buildExportPayload("codex", [oauthConn]);
    expect(payload.format).toBe(EXPORT_FORMAT);
    expect(payload.version).toBe(EXPORT_VERSION);
    expect(payload.provider).toBe("codex");
    expect(payload.connections).toHaveLength(1);
    expect(typeof payload.exportedAt).toBe("string");
  });

  it("builds a date-stamped filename with no account identity in it", () => {
    const name = buildExportFilename("codex", new Date("2026-08-26T10:00:00.000Z"));
    expect(name).toBe("9router-codex-connections-2026-08-26.json");
    expect(name).not.toContain("@");
  });

  it("sanitizes an unsafe provider id in the filename", () => {
    const name = buildExportFilename("../../etc/passwd", new Date("2026-08-26T00:00:00.000Z"));
    expect(name).toBe("9router-.-.-etc-passwd-connections-2026-08-26.json");
  });
});

describe("validateImportPayload", () => {
  const good = buildExportPayload("codex", [oauthConn]);

  it("accepts a matching payload", () => {
    expect(validateImportPayload(good, "codex").connections).toHaveLength(1);
  });

  it("rejects a non-object", () => {
    expect(validateImportPayload("nope", "codex").error).toBeTruthy();
    expect(validateImportPayload([], "codex").error).toBeTruthy();
  });

  it("rejects a wrong format marker", () => {
    expect(validateImportPayload({ ...good, format: "other" }, "codex").error).toMatch(/format/i);
  });

  it("rejects an unsupported version", () => {
    expect(validateImportPayload({ ...good, version: 99 }, "codex").error).toMatch(/version/i);
  });

  it("rejects a file belonging to another provider", () => {
    expect(validateImportPayload({ ...good, provider: "gemini" }, "codex").error).toMatch(/gemini/);
  });

  it("rejects a missing/non-array connections field", () => {
    expect(validateImportPayload({ ...good, connections: undefined }, "codex").error).toBeTruthy();
    expect(validateImportPayload({ ...good, connections: {} }, "codex").error).toBeTruthy();
  });

  it("rejects an empty connections array", () => {
    expect(validateImportPayload({ ...good, connections: [] }, "codex").error).toMatch(/no connections/i);
  });

  it("rejects an oversized file", () => {
    const many = Array.from({ length: 501 }, () => ({ accessToken: "x" }));
    expect(validateImportPayload({ ...good, connections: many }, "codex").error).toMatch(/exceeds/);
  });
});

describe("prepareConnectionForImport", () => {
  it("round-trips an OAuth connection with enabledModels intact", () => {
    const exported = serializeConnectionForExport(oauthConn);
    const { data, proxyPoolId, error } = prepareConnectionForImport(exported, "codex");
    expect(error).toBeUndefined();
    expect(data.provider).toBe("codex");
    expect(data.authType).toBe("oauth");
    expect(data.accessToken).toBe("at-1");
    expect(data.refreshToken).toBe("rt-1");
    expect(data.idToken).toBe("it-1");
    expect(data.email).toBe("a@example.com");
    expect(data.defaultModel).toBe("gpt-5.5");
    expect(data.isActive).toBe(true);
    expect(data.providerSpecificData.enabledModels).toEqual(["gpt-5.5", "sol"]);
    expect(data.providerSpecificData.somethingCustom).toEqual({ nested: true });
    // Local reference is split out, not restored blindly.
    expect(data.providerSpecificData.proxyPoolId).toBeUndefined();
    expect(proxyPoolId).toBe("pool-1");
  });

  it("never carries an exported DB id or timestamps into create input", () => {
    const { data } = prepareConnectionForImport({ ...serializeConnectionForExport(oauthConn), id: "db-id-1", createdAt: "x", updatedAt: "y" }, "codex");
    expect(data.id).toBeUndefined();
    expect(data.createdAt).toBeUndefined();
    expect(data.updatedAt).toBeUndefined();
  });

  it("forces the provider from the wrapper, ignoring a mismatched entry provider", () => {
    const { data } = prepareConnectionForImport({ provider: "gemini", authType: "oauth", accessToken: "at" }, "codex");
    expect(data.provider).toBe("codex");
  });

  it("round-trips an API-key connection", () => {
    const src = { id: "x", provider: "groq", authType: "apikey", name: "Key 1", apiKey: "sk-1", providerSpecificData: { enabledModels: ["a"] } };
    const { data } = prepareConnectionForImport(serializeConnectionForExport(src), "groq");
    expect(data.apiKey).toBe("sk-1");
    expect(data.name).toBe("Key 1");
    expect(data.providerSpecificData.enabledModels).toEqual(["a"]);
  });

  it("round-trips New API inference and management credentials", () => {
    const provider = "openai-compatible-chat-example";
    const src = {
      id: "na-1",
      provider,
      authType: "apikey",
      name: "Example API A",
      apiKey: "inference-secret",
      accessToken: "management-secret",
      providerSpecificData: {
        userId: "123",
        enabledModels: ["model-a"],
        newApiOrigin: "https://example.com",
        newApiLabel: "Example API",
      },
    };
    const exported = serializeConnectionForExport(src);
    const { data } = prepareConnectionForImport(exported, provider);
    expect(data).toMatchObject({
      provider,
      authType: "apikey",
      apiKey: "inference-secret",
      accessToken: "management-secret",
      providerSpecificData: {
        userId: "123",
        enabledModels: ["model-a"],
        // The family markers must survive: usage/models resolution reads them.
        newApiOrigin: "https://example.com",
        newApiLabel: "Example API",
      },
    });
    expect(redactConnection(data)).not.toHaveProperty("apiKey");
    expect(redactConnection(data)).not.toHaveProperty("accessToken");
  });

  it("preserves isActive:false", () => {
    const { data } = prepareConnectionForImport({ authType: "apikey", name: "n", apiKey: "k", isActive: false }, "groq");
    expect(data.isActive).toBe(false);
  });

  it("rejects a non-object entry", () => {
    expect(prepareConnectionForImport(null, "codex").error).toBeTruthy();
    expect(prepareConnectionForImport(["x"], "codex").error).toBeTruthy();
  });

  it("rejects an OAuth entry with no tokens", () => {
    expect(prepareConnectionForImport({ authType: "oauth", email: "a@b.c" }, "codex").error).toMatch(/accessToken/);
  });

  it("rejects an api-key entry with no key", () => {
    expect(prepareConnectionForImport({ authType: "apikey", name: "n" }, "groq").error).toMatch(/apiKey/);
  });

  it("rejects a non-string credential", () => {
    expect(prepareConnectionForImport({ authType: "apikey", name: "n", apiKey: { a: 1 } }, "groq").error).toMatch(/apiKey/);
  });

  it("rejects a non-object providerSpecificData", () => {
    expect(prepareConnectionForImport({ authType: "oauth", accessToken: "at", providerSpecificData: "x" }, "codex").error).toMatch(/providerSpecificData/);
  });

  it("round-trips api_key connections whose credential is stored as accessToken", () => {
    const { data, error } = prepareConnectionForImport({
      authType: "api_key",
      name: "Kiro key",
      accessToken: "key-secret",
    }, "kiro");
    expect(error).toBeUndefined();
    expect(data.accessToken).toBe("key-secret");
  });

  it("allows ollama-local with no credential", () => {
    expect(prepareConnectionForImport({ authType: "apikey", name: "local" }, "ollama-local").error).toBeUndefined();
  });

  it("does not include a credential value in an error message", () => {
    const err = prepareConnectionForImport({ authType: "apikey", name: "n", apiKey: 12345 }, "groq").error;
    expect(err).not.toContain("12345");
  });
});

describe("connectionIdentityKey", () => {
  it("identifies an OAuth account by email + account id", () => {
    expect(connectionIdentityKey(oauthConn)).toBe("oauth|a@example.com|ws-1");
  });

  it("identifies an api-key connection by name", () => {
    expect(connectionIdentityKey({ authType: "apikey", name: "Key 1" })).toBe("apikey|Key 1");
  });

  it("refuses to identify when there is nothing safe to match on", () => {
    expect(connectionIdentityKey({ authType: "oauth", accessToken: "at" })).toBeNull();
    expect(connectionIdentityKey({ authType: "access_token", name: "x" })).toBeNull();
    expect(connectionIdentityKey(null)).toBeNull();
  });

  it("treats two OAuth grants for the same email but different accounts as distinct", () => {
    const a = connectionIdentityKey({ authType: "oauth", email: "a@b.c", providerSpecificData: { chatgptAccountId: "1" } });
    const b = connectionIdentityKey({ authType: "oauth", email: "a@b.c", providerSpecificData: { chatgptAccountId: "2" } });
    expect(a).not.toBe(b);
  });
});

describe("redactConnection", () => {
  it("removes every credential field", () => {
    const out = redactConnection(oauthConn);
    expect(out.apiKey).toBeUndefined();
    expect(out.accessToken).toBeUndefined();
    expect(out.refreshToken).toBeUndefined();
    expect(out.idToken).toBeUndefined();
    expect(out.email).toBe("a@example.com");
  });
});
