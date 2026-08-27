import { beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://example.com";
const PROVIDER_ID = "openai-compatible-chat-example";
const MANAGEMENT_TOKEN = "management-token-fixture";
const USER_ID = "4242";

const NODE = Object.freeze({
  id: PROVIDER_ID,
  type: "openai-compatible",
  apiType: "chat",
  family: "new-api",
  name: "Example API",
  prefix: "ex",
  baseUrl: `${ORIGIN}/v1`,
  newApi: { origin: ORIGIN },
});

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  connect: vi.fn(),
  getNode: vi.fn(),
  listNodes: vi.fn(),
  resolveClient: vi.fn(),
  getConnectionById: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("@/sse/services/newapiBootstrap", () => ({
  inspectNewApiAccount: mocks.inspect,
  connectNewApiAccount: mocks.connect,
  safeConnectionSummary: (connection, account) => ({
    id: connection.id,
    provider: connection.provider,
    providerSpecificData: { userId: account.id },
  }),
}));

vi.mock("@/sse/services/newapiProvider", () => ({
  getNewApiProviderDefinition: mocks.getNode,
  listNewApiProviders: mocks.listNodes,
  resolveNewApiProviderClient: mocks.resolveClient,
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getConnectionById,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

const { POST: startPair } = await import("../../src/app/api/new-api/pair/start/route.js");
const { GET: pairStatus } = await import("../../src/app/api/new-api/pair/status/route.js");
const { POST: completePair, OPTIONS: completeOptions } = await import(
  "../../src/app/api/new-api/pair/complete/route.js"
);
const {
  BRIDGE_VERSION,
  PAIRING_TTL_MS,
  PAIR_PROTOCOL,
  __resetPairingSessions,
} = await import("../../src/lib/newapi/pairing.js");

const ROUTER_HOST = "router.example.com";
const ROUTER_ORIGIN = `https://${ROUTER_HOST}`;

function startRequest(body = {}, { host = ROUTER_HOST, proto = "https" } = {}) {
  return new Request(`http://${host}/api/new-api/pair/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      host,
      "x-forwarded-proto": proto,
    },
    body: JSON.stringify(body),
  });
}

function completeRequest(body, {
  header = BRIDGE_VERSION,
  host = ROUTER_HOST,
  proto = "https",
  origin = ORIGIN,
} = {}) {
  const headers = { "Content-Type": "application/json", host, "x-forwarded-proto": proto };
  if (header !== null) headers["X-9Router-Bridge"] = header;
  if (origin !== null) headers.origin = origin;
  return new Request(`http://${host}/api/new-api/pair/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function openPairing(body = {}, options = {}) {
  const response = await startPair(startRequest({ providerId: PROVIDER_ID, ...body }, options));
  const payload = await response.json();
  return payload.data;
}

async function readStatus(pairingId) {
  const response = await pairStatus(
    new Request(`http://${ROUTER_HOST}/api/new-api/pair/status?id=${encodeURIComponent(pairingId)}`),
  );
  const payload = await response.json();
  return payload.data;
}

function completionBody(pair, overrides = {}) {
  return {
    pairingId: pair.pairingId,
    pairSecret: pair.pairSecret,
    userId: USER_ID,
    managementToken: MANAGEMENT_TOKEN,
    providerOrigin: ORIGIN,
    ...overrides,
  };
}

const CLIENT = { label: "Example API", activeStatus: 1 };

function resetMocks() {
  vi.clearAllMocks();
  vi.useRealTimers();
  __resetPairingSessions();
  mocks.getNode.mockResolvedValue(NODE);
  mocks.listNodes.mockResolvedValue([NODE]);
  mocks.resolveClient.mockResolvedValue({ client: CLIENT, node: NODE });
  mocks.getConnectionById.mockResolvedValue(null);
  mocks.getSettings.mockResolvedValue({});
  mocks.inspect.mockResolvedValue({
    ok: true,
    account: { id: USER_ID, displayName: "Account" },
    tokens: [],
    state: "ready",
  });
  mocks.connect.mockResolvedValue({
    ok: true,
    created: true,
    tokenCreated: false,
    connection: { id: "conn-1", provider: PROVIDER_ID },
    account: { id: USER_ID },
    models: [{ id: "model-a" }],
  });
}

describe("generic New API pairing start", () => {
  beforeEach(resetMocks);

  it("mints a strong single-use pairing and carries the secret only in the fragment", async () => {
    const pair = await openPairing();
    expect(pair.pairingId).toBeTruthy();
    // 32 random bytes, base64url encoded.
    expect(pair.pairSecret.length).toBeGreaterThanOrEqual(43);
    expect(pair.expiresAt - Date.now()).toBeLessThanOrEqual(PAIRING_TTL_MS);

    const url = new URL(pair.loginUrl);
    // The target comes from the persisted definition, not from the request.
    expect(url.origin).toBe(ORIGIN);
    expect(url.search).toBe("");
    expect(url.hash).toContain(`9router_pair_protocol=${PAIR_PROTOCOL}`);
    expect(url.hash).toContain(`9router_provider_id=${encodeURIComponent(PROVIDER_ID)}`);
    expect(url.hash).toContain(`9router_pair_secret=${encodeURIComponent(pair.pairSecret)}`);

    const second = await openPairing();
    expect(second.pairingId).not.toBe(pair.pairingId);
    expect(second.pairSecret).not.toBe(pair.pairSecret);
  });

  it("tells the bridge which 9Router origin to complete against — no localhost assumption", async () => {
    const pair = await openPairing();
    expect(pair.routerOrigin).toBe(ROUTER_ORIGIN);
    expect(new URL(pair.loginUrl).hash)
      .toContain(`9router_router_origin=${encodeURIComponent(ROUTER_ORIGIN)}`);
  });

  it("prefers a configured base URL over the request host", async () => {
    mocks.getSettings.mockResolvedValue({ baseUrl: "https://configured.example/" });
    const pair = await openPairing();
    expect(pair.routerOrigin).toBe("https://configured.example");
  });

  it("rejects a provider that is not a New API definition", async () => {
    mocks.getNode.mockResolvedValue(null);
    const response = await startPair(startRequest({ providerId: "claude" }));
    expect(response.status).toBe(404);
  });

  it("puts the expected account in the fragment for reconnect and rejects a bad id", async () => {
    const pair = await openPairing({ expectedUserId: USER_ID });
    expect(pair.loginUrl).toContain(`expected_user_id=${USER_ID}`);

    const bad = await startPair(startRequest({ providerId: PROVIDER_ID, expectedUserId: "nope" }));
    expect(bad.status).toBe(400);
  });

  it("requires a reconnect target to belong to this provider and account", async () => {
    mocks.getConnectionById.mockResolvedValue({
      id: "conn-other",
      provider: "some-other-provider",
      providerSpecificData: { userId: USER_ID },
    });
    const wrongProvider = await startPair(startRequest({
      providerId: PROVIDER_ID,
      connectionId: "conn-other",
      expectedUserId: USER_ID,
    }));
    expect(wrongProvider.status).toBe(404);

    mocks.getConnectionById.mockResolvedValue({
      id: "conn-1",
      provider: PROVIDER_ID,
      providerSpecificData: { userId: "9999" },
    });
    const wrongAccount = await startPair(startRequest({
      providerId: PROVIDER_ID,
      connectionId: "conn-1",
      expectedUserId: USER_ID,
    }));
    expect(wrongAccount.status).toBe(400);
  });
});

describe("generic New API pairing status", () => {
  beforeEach(resetMocks);

  it("starts pending and never leaks a secret", async () => {
    const pair = await openPairing();
    const status = await readStatus(pair.pairingId);
    expect(status.status).toBe("pending");

    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(pair.pairSecret);
    expect(serialized).not.toContain(MANAGEMENT_TOKEN);
  });

  it("reports an unknown pairing as expired so the UI cannot hang", async () => {
    expect(await readStatus("does-not-exist")).toEqual({ status: "expired" });
  });

  it("expires a pending pairing once its TTL lapses", async () => {
    const pair = await openPairing();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + PAIRING_TTL_MS + 1000);
    expect((await readStatus(pair.pairingId)).status).toBe("expired");
    vi.useRealTimers();
  });
});

describe("generic New API pairing completion", () => {
  beforeEach(resetMocks);

  it("answers the extension preflight for a known provider origin only", async () => {
    const allowed = await completeOptions(new Request(`http://${ROUTER_HOST}/api/new-api/pair/complete`, {
      method: "OPTIONS",
      headers: { origin: ORIGIN },
    }));
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(ORIGIN);

    // An unknown origin gets no CORS grant — and CORS is never authorization anyway.
    const unknown = await completeOptions(new Request(`http://${ROUTER_HOST}/api/new-api/pair/complete`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    }));
    expect(unknown.status).toBe(204);
    expect(unknown.headers.get("access-control-allow-origin")).toBeNull();
    // Vary must be present either way so a cache cannot serve the allowed
    // response to a different origin.
    expect(unknown.headers.get("vary")).toBe("Origin");
  });

  it("requires the bridge protocol marker", async () => {
    const pair = await openPairing();
    const response = await completePair(completeRequest(completionBody(pair), { header: null }));
    expect(response.status).toBe(400);
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it("rejects a forged secret without touching the provider", async () => {
    const pair = await openPairing();
    const response = await completePair(completeRequest(
      completionBody(pair, { pairSecret: "forged-secret" }),
    ));
    expect(response.status).toBe(403);
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it("completes once and returns only the connection id", async () => {
    const pair = await openPairing();
    const response = await completePair(completeRequest(completionBody(pair)));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ success: true, data: { connectionId: "conn-1" } });
    expect(JSON.stringify(payload)).not.toContain(MANAGEMENT_TOKEN);
    expect((await readStatus(pair.pairingId))).toMatchObject({
      status: "success",
      connectionId: "conn-1",
    });
  });

  it("is single-use: a duplicate post cannot bootstrap twice", async () => {
    const pair = await openPairing();
    await completePair(completeRequest(completionBody(pair)));
    const duplicate = await completePair(completeRequest(completionBody(pair)));
    expect(duplicate.status).toBe(403);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });

  it("resolves the provider from the pairing, never from the body", async () => {
    const pair = await openPairing();
    await completePair(completeRequest(completionBody(pair, {
      providerId: "attacker-chosen-provider",
    })));
    expect(mocks.resolveClient).toHaveBeenCalledWith(PROVIDER_ID);
  });

  it("rejects a providerOrigin that disagrees with the pairing", async () => {
    const pair = await openPairing();
    const response = await completePair(completeRequest(completionBody(pair, {
      providerOrigin: "https://evil.example",
    })));
    expect(response.status).toBe(403);
    expect((await response.json()).errorCode).toBe("provider_mismatch");
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it("requires a providerOrigin assertion at all", async () => {
    const pair = await openPairing();
    const response = await completePair(completeRequest(completionBody(pair, {
      providerOrigin: undefined,
    })));
    expect(response.status).toBe(403);
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it("refuses a completion that arrived at a different 9Router origin", async () => {
    const pair = await openPairing();
    const response = await completePair(completeRequest(completionBody(pair), {
      host: "someone-else.example",
    }));
    expect(response.status).toBe(403);
    expect((await response.json()).errorCode).toBe("router_origin_mismatch");
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it("accepts a host match when the proxy did not forward the scheme", async () => {
    // Otherwise a proxy that forwards Host but not X-Forwarded-Proto would 403
    // every completion on an https deployment.
    const pair = await openPairing();
    const response = await completePair(completeRequest(completionBody(pair), { proto: "http" }));
    expect(response.status).toBe(200);
  });

  it("echoes an exact chrome-extension origin for the MV3 service worker", async () => {
    const extensionOrigin = `chrome-extension://${"a".repeat(32)}`;
    const allowed = await completeOptions(new Request(`http://${ROUTER_HOST}/api/new-api/pair/complete`, {
      method: "OPTIONS",
      headers: { origin: extensionOrigin },
    }));
    expect(allowed.headers.get("access-control-allow-origin")).toBe(extensionOrigin);

    // A malformed extension id gets nothing.
    const bogus = await completeOptions(new Request(`http://${ROUTER_HOST}/api/new-api/pair/complete`, {
      method: "OPTIONS",
      headers: { origin: "chrome-extension://not-a-valid-id" },
    }));
    expect(bogus.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("never answers a failed pairing with a 2xx", async () => {
    // New API reports business errors as HTTP 200 + {success:false}, and that
    // status rides along through the client — it must be clamped here.
    mocks.inspect.mockResolvedValue({ ok: false, status: 200, message: "upstream refused" });
    const pair = await openPairing();
    const response = await completePair(completeRequest(completionBody(pair)));
    expect(response.status).toBe(502);
    expect((await response.json()).errorCode).toBe("management_auth_failed");
  });

  it("still accepts a loopback completion for a remotely-served dashboard", async () => {
    // Pairing state is per-process in memory, so a loopback POST provably reached
    // the same 9Router that minted it — the tunnel/proxy case.
    const pair = await openPairing();
    const response = await completePair(completeRequest(completionBody(pair), {
      host: "localhost:20128",
      proto: "http",
    }));
    expect(response.status).toBe(200);
  });

  it("enforces the expected account on reconnect", async () => {
    const pair = await openPairing({ expectedUserId: "9999" });
    const response = await completePair(completeRequest(completionBody(pair)));
    expect(response.status).toBe(403);
    expect((await response.json()).errorCode).toBe("wrong_account");
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it("rejects a server-side account id that disagrees with the posted id", async () => {
    mocks.inspect.mockResolvedValue({
      ok: true,
      account: { id: "9999" },
      tokens: [],
      state: "ready",
    });
    const pair = await openPairing();
    const response = await completePair(completeRequest(completionBody(pair)));
    expect(response.status).toBe(403);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("surfaces an invalid management credential without echoing it", async () => {
    mocks.inspect.mockResolvedValue({
      ok: false,
      status: 401,
      message: "Example API management authentication failed.",
    });
    const pair = await openPairing();
    const response = await completePair(completeRequest(completionBody(pair)));
    const body = await response.text();
    expect(response.status).toBe(401);
    expect(body).not.toContain(MANAGEMENT_TOKEN);
    expect((await readStatus(pair.pairingId)).errorCode).toBe("management_auth_failed");
  });

  it("rejects a malformed payload before any upstream call", async () => {
    const pair = await openPairing();
    for (const overrides of [
      { userId: "not-numeric" },
      { managementToken: "" },
      { managementToken: "x".repeat(9000) },
    ]) {
      const response = await completePair(completeRequest(completionBody(pair, overrides)));
      expect(response.status).toBe(400);
    }
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it("passes the definition's connection data through to the bootstrap", async () => {
    const pair = await openPairing();
    await completePair(completeRequest(completionBody(pair)));
    expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({
      providerId: PROVIDER_ID,
      connectionData: expect.objectContaining({
        newApiOrigin: ORIGIN,
        newApiLabel: "Example API",
        baseUrl: `${ORIGIN}/v1`,
      }),
    }));
  });
});
