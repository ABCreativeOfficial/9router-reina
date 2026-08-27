import { beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://example.com";
const PROVIDER_ID = "openai-compatible-chat-example";

const mocks = vi.hoisted(() => ({
  getProviderNodeById: vi.fn(),
  getProviderNodes: vi.fn(),
  updateProviderNode: vi.fn(),
  deleteProviderNode: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  deleteProviderConnectionsByProvider: vi.fn(),
}));

vi.mock("@/models", () => mocks);

const { PUT, DELETE } = await import("../../src/app/api/provider-nodes/[id]/route.js");

const newApiNode = {
  id: PROVIDER_ID,
  type: "openai-compatible",
  apiType: "chat",
  family: "new-api",
  name: "Example API",
  prefix: "ex",
  baseUrl: `${ORIGIN}/v1`,
  newApi: { origin: ORIGIN },
};

const plainNode = {
  id: "openai-compatible-chat-plain",
  type: "openai-compatible",
  apiType: "chat",
  name: "Plain",
  prefix: "pl",
  baseUrl: "https://plain.example/v1",
};

function putRequest(body) {
  return new Request("http://localhost/api/provider-nodes/x", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("New API definition immutability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderNodes.mockResolvedValue([]);
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.updateProviderNode.mockImplementation(async (id, data) => ({ id, ...data }));
    mocks.deleteProviderNode.mockResolvedValue({ id: PROVIDER_ID });
    mocks.deleteProviderConnectionsByProvider.mockResolvedValue(undefined);
  });

  it("refuses to retarget a New API provider's origin", async () => {
    mocks.getProviderNodeById.mockResolvedValue(newApiNode);
    const response = await PUT(
      putRequest({ name: "Renamed", prefix: "ex", apiType: "chat", baseUrl: "https://evil.example/v1" }),
      { params: Promise.resolve({ id: PROVIDER_ID }) },
    );
    expect(response.status).toBe(409);
    // Nothing may be written: this handler re-syncs baseUrl onto every connection,
    // so a successful edit would point stored credentials at another host.
    expect(mocks.updateProviderNode).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("still allows editing an ordinary compatible node", async () => {
    mocks.getProviderNodeById.mockResolvedValue(plainNode);
    const response = await PUT(
      putRequest({ name: "Plain 2", prefix: "pl", apiType: "chat", baseUrl: "https://plain.example/v1" }),
      { params: Promise.resolve({ id: plainNode.id }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.updateProviderNode).toHaveBeenCalled();
  });

  it("refuses a prefix that another node already owns", async () => {
    mocks.getProviderNodeById.mockResolvedValue(plainNode);
    // The New API definition owns "ex"; a plain node must not shadow it.
    mocks.getProviderNodes.mockResolvedValue([newApiNode, plainNode]);
    const response = await PUT(
      putRequest({ name: "Plain", prefix: "ex", apiType: "chat", baseUrl: "https://plain.example/v1" }),
      { params: Promise.resolve({ id: plainNode.id }) },
    );
    expect(response.status).toBe(409);
    expect(mocks.updateProviderNode).not.toHaveBeenCalled();
  });

  it("lets a node keep its own prefix", async () => {
    mocks.getProviderNodeById.mockResolvedValue(plainNode);
    mocks.getProviderNodes.mockResolvedValue([newApiNode, plainNode]);
    const response = await PUT(
      putRequest({ name: "Plain 2", prefix: "pl", apiType: "chat", baseUrl: "https://plain.example/v1" }),
      { params: Promise.resolve({ id: plainNode.id }) },
    );
    expect(response.status).toBe(200);
  });

  it("allows deleting a New API provider along with its connections", async () => {
    mocks.getProviderNodeById.mockResolvedValue(newApiNode);
    const response = await DELETE(new Request("http://localhost/api/provider-nodes/x", { method: "DELETE" }), {
      params: Promise.resolve({ id: PROVIDER_ID }),
    });
    expect(response.status).toBe(200);
    expect(mocks.deleteProviderConnectionsByProvider).toHaveBeenCalledWith(PROVIDER_ID);
    expect(mocks.deleteProviderNode).toHaveBeenCalledWith(PROVIDER_ID);
  });
});
