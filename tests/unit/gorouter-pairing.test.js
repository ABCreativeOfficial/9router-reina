import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("@/sse/services/gorouterBootstrap", () => ({
  inspectGoRouterAccount: mocks.inspect,
  connectGoRouterAccount: mocks.connect,
  safeConnectionSummary: (connection, account) => ({
    id: connection.id,
    provider: connection.provider,
    providerSpecificData: { userId: account.id },
  }),
}));

const { POST: startPair } = await import("../../src/app/api/providers/gorouter/pair/start/route.js");
const { GET: pairStatus } = await import("../../src/app/api/providers/gorouter/pair/status/route.js");
const { POST: completePair, OPTIONS: completeOptions } = await import(
  "../../src/app/api/providers/gorouter/pair/complete/route.js"
);
const {
  BRIDGE_VERSION,
  PAIRING_TTL_MS,
  __resetPairingSessions,
} = await import("../../src/lib/gorouter/pairing.js");

const MANAGEMENT_TOKEN = "management-token-fixture";
const USER_ID = "4242";

function startRequest(body = {}) {
  return new Request("http://localhost/api/providers/gorouter/pair/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function completeRequest(body, { header = BRIDGE_VERSION } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (header !== null) headers["X-9Router-Bridge"] = header;
  return new Request("http://localhost/api/providers/gorouter/pair/complete", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function openPairing(body = {}) {
  const response = await startPair(startRequest(body));
  const payload = await response.json();
  return payload.data;
}

async function readStatus(pairingId) {
  const response = await pairStatus(
    new Request(`http://localhost/api/providers/gorouter/pair/status?id=${encodeURIComponent(pairingId)}`),
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
    ...overrides,
  };
}

describe("GoRouter pairing start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    __resetPairingSessions();
  });

  it("mints a strong single-use pairing and carries the secret only in the fragment", async () => {
    const pair = await openPairing();
    expect(pair.pairingId).toBeTruthy();
    // 32 random bytes, base64url encoded.
    expect(pair.pairSecret.length).toBeGreaterThanOrEqual(43);
    expect(pair.expiresAt - Date.now()).toBeLessThanOrEqual(PAIRING_TTL_MS);

    const url = new URL(pair.loginUrl);
    expect(url.origin).toBe("https://gorouter.app");
    expect(url.search).toBe("");
    expect(url.hash).toContain(`9router_pair_secret=${encodeURIComponent(pair.pairSecret)}`);

    const second = await openPairing();
    expect(second.pairingId).not.toBe(pair.pairingId);
    expect(second.pairSecret).not.toBe(pair.pairSecret);
  });

  it("puts the expected account in the fragment for reconnect and rejects a bad id", async () => {
    const pair = await openPairing({ expectedUserId: USER_ID });
    expect(pair.loginUrl).toContain(`expected_user_id=${USER_ID}`);

    const bad = await startPair(startRequest({ expectedUserId: "not-numeric" }));
    expect(bad.status).toBe(400);
  });
});

describe("GoRouter pairing status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    __resetPairingSessions();
  });

  it("starts pending and never leaks a secret", async () => {
    const pair = await openPairing();
    const status = await readStatus(pair.pairingId);
    expect(status.status).toBe("pending");

    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(pair.pairSecret);
    expect(serialized).not.toContain(MANAGEMENT_TOKEN);
    expect(status.pairSecret).toBeUndefined();
    expect(status.managementToken).toBeUndefined();
    expect(status.apiKey).toBeUndefined();
  });

  it("reports an unknown pairing as expired", async () => {
    expect((await readStatus("does-not-exist")).status).toBe("expired");
  });

  it("expires a pending pairing once its TTL lapses", async () => {
    const pair = await openPairing();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + PAIRING_TTL_MS + 1000);
    expect((await readStatus(pair.pairingId)).status).toBe("expired");

    const response = await completePair(completeRequest(completionBody(pair)));
    expect(response.status).toBe(403);
    expect((await response.json()).errorCode).toBe("expired");
    expect(mocks.inspect).not.toHaveBeenCalled();
  });
});

describe("GoRouter pairing completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    __resetPairingSessions();
    mocks.inspect.mockResolvedValue({
      ok: true,
      account: { id: USER_ID, displayName: "Account", group: "default", status: 1 },
      tokens: [{ id: 7, name: "9router", status: 1, maskedKey: "abcd**********wxyz" }],
      state: "ready",
    });
    mocks.connect.mockResolvedValue({
      ok: true,
      created: true,
      connection: { id: "connection-1", provider: "gorouter", name: "9router" },
      account: { id: USER_ID },
      models: [{ id: "model-a" }],
    });
  });

  it("answers the extension preflight without treating origin as auth", async () => {
    const response = await completeOptions();
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://gorouter.app");
  });

  it("requires the bridge protocol marker", async () => {
    const pair = await openPairing();
    const response = await completePair(completeRequest(completionBody(pair), { header: "wrong-version" }));
    expect(response.status).toBe(400);
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it("rejects a forged secret without touching GoRouter", async () => {
    const pair = await openPairing();
    const response = await completePair(
      completeRequest(completionBody(pair, { pairSecret: "forged-secret-value" })),
    );
    expect(response.status).toBe(403);
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect((await readStatus(pair.pairingId)).status).toBe("pending");
  });

  it("completes once and returns only the connection id", async () => {
    const pair = await openPairing();
    const response = await completePair(completeRequest(completionBody(pair)));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ success: true, data: { connectionId: "connection-1" } });
    expect(JSON.stringify(payload)).not.toContain(MANAGEMENT_TOKEN);
    expect(JSON.stringify(payload)).not.toContain(pair.pairSecret);
    expect((await readStatus(pair.pairingId)).status).toBe("success");
  });

  it("is single-use: a duplicate post cannot bootstrap twice", async () => {
    const pair = await openPairing();
    const first = await completePair(completeRequest(completionBody(pair)));
    expect(first.status).toBe(200);

    const duplicate = await completePair(completeRequest(completionBody(pair)));
    expect(duplicate.status).toBe(403);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });

  it("claims pending before upstream work so concurrent posts do not race", async () => {
    const pair = await openPairing();
    let observedDuringUpstream = null;
    mocks.inspect.mockImplementation(async () => {
      observedDuringUpstream = (await readStatus(pair.pairingId)).status;
      return {
        ok: true,
        account: { id: USER_ID, displayName: "Account", group: "default", status: 1 },
        tokens: [{ id: 7, status: 1 }],
        state: "ready",
      };
    });

    await completePair(completeRequest(completionBody(pair)));
    expect(observedDuringUpstream).toBe("processing");
  });

  it("enforces the expected account on reconnect", async () => {
    const pair = await openPairing({ expectedUserId: USER_ID });
    const wrong = await completePair(completeRequest(completionBody(pair, { userId: "9999" })));
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).errorCode).toBe("wrong_account");
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect((await readStatus(pair.pairingId)).status).toBe("error");
  });

  it("accepts a newly detected account when adding an account", async () => {
    mocks.inspect.mockResolvedValue({
      ok: true,
      account: { id: "5150", displayName: "Fresh", group: "default", status: 1 },
      tokens: [{ id: 7, status: 1 }],
      state: "ready",
    });
    mocks.connect.mockResolvedValue({
      ok: true,
      created: true,
      connection: { id: "connection-2", provider: "gorouter" },
      account: { id: "5150" },
      models: [],
    });

    const pair = await openPairing();
    const response = await completePair(completeRequest(completionBody(pair, { userId: "5150" })));
    expect(response.status).toBe(200);
    expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({ userId: "5150" }));
  });

  it("rejects a server-side account id that disagrees with the posted id", async () => {
    mocks.inspect.mockResolvedValue({
      ok: true,
      account: { id: "7777", displayName: "Other", status: 1 },
      tokens: [{ id: 7, status: 1 }],
      state: "ready",
    });
    const pair = await openPairing();
    const response = await completePair(completeRequest(completionBody(pair)));
    expect(response.status).toBe(403);
    expect((await response.json()).errorCode).toBe("wrong_account");
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("surfaces an invalid management credential without echoing it", async () => {
    mocks.inspect.mockResolvedValue({
      ok: false,
      status: 401,
      message: "GoRouter management authentication failed.",
    });
    const pair = await openPairing();
    const response = await completePair(completeRequest(completionBody(pair)));
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload.errorCode).toBe("management_auth_failed");
    expect(JSON.stringify(payload)).not.toContain(MANAGEMENT_TOKEN);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect((await readStatus(pair.pairingId)).status).toBe("error");
  });

  it("requires explicit token creation when no usable token exists", async () => {
    mocks.inspect.mockResolvedValue({
      ok: true,
      account: { id: USER_ID, displayName: "Account", status: 1 },
      tokens: [{ id: 7, status: 0 }],
      state: "needs_token_creation",
    });
    const pair = await openPairing();
    const response = await completePair(completeRequest(completionBody(pair)));

    expect(response.status).toBe(409);
    expect((await response.json()).errorCode).toBe("needs_token_creation");
    expect(mocks.connect).not.toHaveBeenCalled();
    expect((await readStatus(pair.pairingId)).status).toBe("needs_token_creation");
  });

  it("rejects a malformed payload before any upstream call", async () => {
    const pair = await openPairing();
    const missingToken = await completePair(completeRequest(completionBody(pair, { managementToken: "" })));
    expect(missingToken.status).toBe(400);

    const badUser = await completePair(completeRequest(completionBody(pair, { userId: "abc" })));
    expect(badUser.status).toBe(400);
    expect(mocks.inspect).not.toHaveBeenCalled();
  });
});
