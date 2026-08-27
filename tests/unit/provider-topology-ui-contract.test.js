import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const USAGE = read("../../src/shared/components/UsageStats.js");
const TOPOLOGY = read("../../src/app/(dashboard)/dashboard/usage/components/ProviderTopology.js");

describe("provider-only topology wiring", () => {
  it("normalizes connections before passing topology providers", () => {
    expect(USAGE).toContain("buildProviderTopologyProviders(");
    expect(USAGE).toContain("setProviders([...providerEntities, ...noAuthProviders])");
  });

  it("does not use connection name as a node-label fallback", () => {
    expect(TOPOLOGY).toContain("label: p.label");
    expect(TOPOLOGY).not.toMatch(/\|\|\s*p\.name\s*\|\|/);
    expect(TOPOLOGY).not.toMatch(/\|\|\s*p\.nodeName\s*\|\|/);
  });

  it("keeps the internal provider id as the graph identity", () => {
    expect(TOPOLOGY).toContain("const nodeId = `provider-${p.provider}`");
    expect(TOPOLOGY).toContain("activeSet.has(p.provider?.toLowerCase())");
  });

  it("uses initials directly for New API nodes without requesting a generated-id image", () => {
    expect(TOPOLOGY).toContain("imageUrl: p.isNewApi ? null : getProviderImageUrl(p.provider)");
    expect(TOPOLOGY).toContain("textIcon: p.textIcon");
  });
});
