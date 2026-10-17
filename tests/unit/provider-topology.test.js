import { describe, expect, it } from "vitest";
import { buildProviderTopologyProviders } from "../../src/shared/utils/providerTopology.js";

const PROVIDER_ID = "openai-compatible-chat-730b7f20-generated";
const node = {
  id: PROVIDER_ID,
  type: "openai-compatible",
  family: "new-api",
  name: "GoRouter",
  prefix: "gor",
  newApi: { origin: "https://example.com" },
};

const connection = (id, name) => ({
  id,
  provider: PROVIDER_ID,
  name,
  isActive: true,
  providerSpecificData: {
    newApiOrigin: "https://example.com",
    newApiLabel: "GoRouter",
    prefix: "gor",
  },
});

describe("Usage & Analytics provider topology", () => {
  it("collapses multiple connections into one provider node", () => {
    const providers = buildProviderTopologyProviders([
      connection("a", "orderbeemax-stack"),
      connection("b", "second-account"),
    ], [node]);

    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      provider: PROVIDER_ID,
      connectionCount: 2,
    });
  });

  it("uses the persisted provider label, never account name or generated id", () => {
    const [provider] = buildProviderTopologyProviders([
      connection("a", "orderbeemax-stack"),
    ], [node]);

    expect(provider.label).toBe("GoRouter");
    expect(provider.label).not.toBe("orderbeemax-stack");
    expect(provider.label).not.toContain("openai-compatible-chat");
    expect(provider.textIcon).toBe("GO");
    expect(provider.isNewApi).toBe(true);
  });

  it("falls back to connection metadata when the provider node is unavailable", () => {
    const [provider] = buildProviderTopologyProviders([
      connection("a", "account-name"),
    ]);

    expect(provider.label).toBe("GoRouter");
    expect(provider.textIcon).toBe("GO");
  });

  it("keeps different provider ids as separate nodes", () => {
    const providers = buildProviderTopologyProviders([
      connection("a", "account-name"),
      { id: "c", provider: "codex", name: "Codex Account", isActive: true },
    ], [node]);

    expect(providers.map((provider) => provider.provider).sort()).toEqual([
      PROVIDER_ID,
      "codex",
    ].sort());
  });

  it("excludes inactive connections", () => {
    const providers = buildProviderTopologyProviders([
      { ...connection("a", "account-name"), isActive: false },
    ], [node]);
    expect(providers).toEqual([]);
  });

  it("drops a leftover connection whose provider cannot be resolved", () => {
    // A test seed / orphan row has no registry entry, no provider node and no
    // dynamic markers. It must not become a graph node the router cannot route.
    const providers = buildProviderTopologyProviders([
      { id: "x", provider: "openai-compatible-upd-1790662141806", name: "seed-0", isActive: true },
    ], []);
    expect(providers).toEqual([]);
  });

  it("keeps a dynamic provider that carries its own markers without a node", () => {
    const providers = buildProviderTopologyProviders([
      {
        id: "d1",
        provider: "openai-compatible-chat-generated",
        name: "account",
        isActive: true,
        providerSpecificData: { newApiOrigin: "https://example.com", newApiLabel: "Example" },
      },
    ], []);
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      provider: "openai-compatible-chat-generated",
      label: "Example",
      isNewApi: true,
    });
  });

  it("keeps a provider the caller resolves outside the registry", () => {
    const providers = buildProviderTopologyProviders([
      { id: "k", provider: "runtime-provider", name: "account", isActive: true },
    ], [], { isKnownProvider: (id) => id === "runtime-provider" });
    expect(providers.map((provider) => provider.provider)).toEqual(["runtime-provider"]);
  });
});
