import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getDisabledModels: vi.fn(async () => ({})),
  fetchNewApiModels: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getCombos: mocks.getCombos,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: mocks.getDisabledModels,
}));

vi.mock("@/sse/services/tokenRefresh", () => ({ updateProviderCredentials: vi.fn() }));

// The route resolves a management client from each connection's own trusted
// origin; only that factory is stubbed, so the family detection stays real.
vi.mock("open-sse/services/newapi/resolve.js", () => ({
  createNewApiClientForConnection: (connection) => (
    connection?.providerSpecificData?.newApiOrigin
      ? { fetchModels: mocks.fetchNewApiModels }
      : null
  ),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");
const { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } = await import("open-sse/config/providerModels.js");
const { getProviderAlias } = await import("@/shared/constants/providers");

// claude is a static-catalog provider with no LIVE_MODEL_RESOLVERS entry, so the
// list comes straight from the registry + per-account policy.
const PROVIDER_ID = "claude";
const OUTPUT_ALIAS = getProviderAlias(PROVIDER_ID);
const STATIC_ALIAS = PROVIDER_ID_TO_ALIAS[PROVIDER_ID];
const [MODEL_A, MODEL_B] = PROVIDER_MODELS[STATIC_ALIAS].map((m) => m.id);
const qualified = (id) => `${OUTPUT_ALIAS}/${id}`;

const conn = (id, enabledModels) => ({
  id,
  provider: PROVIDER_ID,
  isActive: true,
  authType: "oauth",
  providerSpecificData: enabledModels ? { enabledModels } : {},
});

const idsFor = async () => {
  const models = await buildModelsList(["llm"], { skipDynamicFetch: true });
  return models.filter((m) => m.owned_by === OUTPUT_ALIAS).map((m) => m.id);
};

describe("/v1/models — per-account policy visibility", () => {
  // clearAllMocks() clears calls but not implementations, so re-assert the
  // no-disabled-models default rather than inheriting a prior test's override.
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDisabledModels.mockResolvedValue({});
  });

  it("unrestricted accounts expose the full static catalog (no regression)", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("A")]);
    const ids = await idsFor();
    expect(ids.length).toBe(PROVIDER_MODELS[STATIC_ALIAS].length);
  });

  it("a single restricted account narrows the list to its allowlist", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("A", [MODEL_A])]);
    expect(await idsFor()).toEqual([qualified(MODEL_A)]);
  });

  it("per-account restriction is NOT global: one unrestricted account keeps everything visible", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("A", [MODEL_A]), conn("B")]);
    const ids = await idsFor();
    expect(ids.length).toBe(PROVIDER_MODELS[STATIC_ALIAS].length);
    expect(ids).toContain(qualified(MODEL_A));
  });

  it("unions allowlists when every account is restricted", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("A", [MODEL_A]), conn("B", [MODEL_B])]);
    expect((await idsFor()).sort()).toEqual([qualified(MODEL_A), qualified(MODEL_B)].sort());
  });

  it("the global disabled-model list stays independent and still hides a model", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("A", [MODEL_A, MODEL_B])]);
    mocks.getDisabledModels.mockResolvedValue({ [OUTPUT_ALIAS]: [MODEL_A] });
    expect(await idsFor()).toEqual([qualified(MODEL_B)]);
  });

  it("a level-only allowlist still lists the base model", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("A", [`${MODEL_A}(low)`, `${MODEL_A}(high)`])]);
    expect(await idsFor()).toEqual([qualified(MODEL_A)]);
  });

  // A New API provider id is user-created: it lives in the openai-compatible
  // namespace and is in no static registry list. `newApiOrigin` on the connection
  // is what makes it per-account live.
  const NEW_API_PROVIDER = "openai-compatible-chat-example";
  const newApiConn = (id, userId, enabledModels) => ({
    id,
    provider: NEW_API_PROVIDER,
    isActive: true,
    accessToken: `management-${id}`,
    providerSpecificData: {
      userId,
      prefix: "ex",
      newApiOrigin: "https://example.com",
      newApiLabel: "Example API",
      ...(enabledModels ? { enabledModels } : {}),
    },
  });

  it("unions each New API account catalog after applying its allowlist", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      newApiConn("A", "1", ["model-a"]),
      newApiConn("B", "2", ["model-b"]),
    ]);
    mocks.fetchNewApiModels
      .mockResolvedValueOnce({ ok: true, models: [{ id: "model-a" }, { id: "model-x" }] })
      .mockResolvedValueOnce({ ok: true, models: [{ id: "model-b" }, { id: "model-y" }] });

    const models = await buildModelsList(["llm"], { skipDynamicFetch: true });
    const ids = models.filter((model) => model.owned_by === "ex").map((model) => model.id).sort();
    expect(ids).toEqual(["ex/model-a", "ex/model-b"]);
    expect(mocks.fetchNewApiModels).toHaveBeenCalledTimes(2);
  });

  it("an unrestricted New API account keeps its whole catalog visible", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      newApiConn("A", "1", ["model-a"]),
      newApiConn("B", "2"),
    ]);
    mocks.fetchNewApiModels
      .mockResolvedValueOnce({ ok: true, models: [{ id: "model-a" }, { id: "model-x" }] })
      .mockResolvedValueOnce({ ok: true, models: [{ id: "model-b" }] });

    const models = await buildModelsList(["llm"], { skipDynamicFetch: true });
    const ids = models.filter((model) => model.owned_by === "ex").map((model) => model.id).sort();
    expect(ids).toEqual(["ex/model-a", "ex/model-b"]);
    expect(mocks.fetchNewApiModels).toHaveBeenCalledTimes(2);
  });
});
