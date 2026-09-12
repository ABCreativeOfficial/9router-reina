import { beforeEach, describe, expect, it, vi } from "vitest";

const PROVIDER_ID = "openai-compatible-chat-runtime";
const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getDisabledModels: vi.fn(async () => ({})),
  fetchModels: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getCombos: vi.fn(async () => []),
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.getDisabledModels }));
vi.mock("@/sse/services/tokenRefresh", () => ({ updateProviderCredentials: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock("open-sse/services/newapi/resolve.js", () => ({
  createNewApiClientForConnection: (connection) => connection?.providerSpecificData?.newApiOrigin
    ? { fetchModels: mocks.fetchModels }
    : null,
}));

const { GET } = await import("../../src/app/api/models/runtime/route.js");

const connection = (id, enabledModels) => ({
  id,
  provider: PROVIDER_ID,
  isActive: true,
  accessToken: `management-${id}`,
  providerSpecificData: {
    userId: id,
    newApiOrigin: "https://example.com",
    newApiLabel: "Runtime API",
    prefix: "rt",
    ...(enabledModels ? { enabledModels } : {}),
  },
});

const request = () => new Request(`http://localhost/api/models/runtime?provider=${PROVIDER_ID}`);

describe("GET /api/models/runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue({});
  });

  it("unions all active New API accounts after each enabledModels policy", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      connection("A", ["model-a"]),
      connection("B", ["model-b"]),
    ]);
    mocks.fetchModels
      .mockResolvedValueOnce({ ok: true, models: [{ id: "model-a" }, { id: "blocked-a" }] })
      .mockResolvedValueOnce({ ok: true, models: [{ id: "model-b" }, { id: "blocked-b" }] });

    const response = await GET(request());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.providers[PROVIDER_ID].map((model) => model.id).sort()).toEqual(["model-a", "model-b"]);
    expect(mocks.getCustomModels).not.toHaveBeenCalled();
    expect(mocks.getModelAliases).not.toHaveBeenCalled();
    expect(mocks.fetchModels).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(data)).not.toContain("model-id");
  });

  it("uses the dynamic prefix while keeping provider identity and live names", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("A")]);
    mocks.fetchModels.mockResolvedValue({ ok: true, models: [{ id: "gpt-5.2", name: "GPT 5.2" }] });

    const data = await (await GET(request())).json();
    expect(data.providers).toEqual({ [PROVIDER_ID]: [{ id: "gpt-5.2", name: "GPT 5.2" }] });
  });

  it("does not leak stale aliases, custom rows, or placeholders into the live catalog", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("A")]);
    mocks.getCustomModels.mockResolvedValue([{ providerAlias: PROVIDER_ID, id: "stale-custom" }]);
    mocks.getModelAliases.mockResolvedValue({ stale: `${PROVIDER_ID}/stale-alias` });
    mocks.fetchModels.mockResolvedValue({ ok: true, models: [{ id: "live" }] });

    const data = await (await GET(request())).json();
    expect(data.providers[PROVIDER_ID].map((model) => model.id)).toEqual(["live"]);
    expect(JSON.stringify(data)).not.toContain("model-id");
  });

  it("does not fetch an unrequested runtime provider", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      connection("A"),
      {
        ...connection("other"),
        provider: "openai-compatible-chat-other",
        providerSpecificData: {
          ...connection("other").providerSpecificData,
          prefix: "other",
        },
      },
    ]);
    mocks.fetchModels.mockImplementation(async (_token, userId) => ({
      ok: true,
      models: [{ id: `model-${userId}` }],
    }));

    const data = await (await GET(request())).json();
    expect(data.providers[PROVIDER_ID].map((model) => model.id)).toEqual(["model-A"]);
    expect(mocks.fetchModels).toHaveBeenCalledTimes(1);
  });

  it("does not leak unrelated static providers into a filtered fresh request", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);
    const data = await (await GET(request())).json();
    expect(data.providers).toEqual({ [PROVIDER_ID]: [] });
  });
});
