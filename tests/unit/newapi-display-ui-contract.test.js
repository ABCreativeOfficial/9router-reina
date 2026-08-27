import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const PROVIDERS_PAGE = read("../../src/app/(dashboard)/dashboard/providers/page.js");
const PROVIDER_DETAIL = read("../../src/app/(dashboard)/dashboard/providers/[id]/page.js");
const QUOTA = read("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js");
const CLIENT_ROUTE = read("../../src/app/api/providers/client/route.js");

describe("dynamic New API display wiring", () => {
  it("builds list-card initials from the persisted node prefix", () => {
    expect(PROVIDERS_PAGE).toContain("getNewApiInitials(node.prefix, node.name)");
    expect(PROVIDERS_PAGE).not.toMatch(/textIcon:\s*["']NA["']/);
  });

  it("builds detail-page initials from the same persisted prefix", () => {
    expect(PROVIDER_DETAIL).toContain("getNewApiInitials(providerNode.prefix, providerNode.name)");
  });

  it("sends safe New API prefix + label metadata to Quota Tracker", () => {
    expect(CLIENT_ROUTE).toContain('"newApiOrigin", "newApiLabel", "prefix"');
    expect(CLIENT_ROUTE).toContain("label: getProviderDisplayName(connection)");
    expect(CLIENT_ROUTE).toContain("initials: getProviderDisplayInitials(connection)");
    expect(CLIENT_ROUTE).toContain("providerDisplay,");
  });

  it("renders Quota Tracker cards and filters through display metadata", () => {
    expect(QUOTA).toContain("const providerDisplayName = getProviderDisplayName(conn)");
    expect(QUOTA).toContain("const providerDisplayInitials = getProviderDisplayInitials(conn)");
    expect(QUOTA).toContain("{providerDisplayName}");
    expect(QUOTA).toContain("fallbackText={providerDisplayInitials}");
    expect(QUOTA).toContain("{provider.label}");
    expect(QUOTA).toContain("fallbackText={provider.initials}");
  });

  it("keeps internal ids for requests, filters, and image paths", () => {
    expect(QUOTA).toContain("setProviderFilter(provider.id)");
    expect(QUOTA).toContain("provider.isNewApi ? undefined : `/providers/${provider.id}.png`");
    expect(QUOTA).toContain("isNewApiConnection(conn) ? undefined : `/providers/${conn.provider}.png`");
  });
});
