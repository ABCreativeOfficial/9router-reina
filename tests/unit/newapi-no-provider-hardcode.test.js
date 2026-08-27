import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The New API layer must be provider-id independent: adding a third compatible
 * deployment is a dashboard action, not a source edit. These read the actual
 * files rather than asserting on prose, so a comment mentioning a deployment name
 * cannot fail them — only real code identifiers can.
 */
const NEW_API_SOURCES = [
  "open-sse/services/newapi/client.js",
  "open-sse/services/newapi/definition.js",
  "open-sse/services/newapi/resolve.js",
  "open-sse/services/newapi/tokenPolicy.js",
  "open-sse/services/newapi/usage.js",
  "open-sse/services/usage/newapi.js",
  "open-sse/services/usage.js",
  "src/sse/services/newapiBootstrap.js",
  "src/sse/services/newapiProvider.js",
  "src/lib/newapi/pairing.js",
  "src/lib/newapi/routerOrigin.js",
  "src/app/api/new-api/providers/route.js",
  "src/app/api/new-api/bootstrap/route.js",
  "src/app/api/new-api/pair/start/route.js",
  "src/app/api/new-api/pair/status/route.js",
  "src/app/api/new-api/pair/complete/route.js",
  "src/shared/components/NewApiAuthModal.js",
  "src/app/(dashboard)/dashboard/providers/components/AddNewApiProviderModal.js",
  "src/app/api/v1/models/route.js",
  "src/app/api/providers/[id]/models/route.js",
  "src/dashboardGuard.js",
];

/** Strip line and block comments so prose cannot trip the assertions. */
function readCode(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("New API implementation is provider-id independent", () => {
  it("names no specific deployment in code", () => {
    for (const path of NEW_API_SOURCES) {
      const code = readCode(path);
      expect(code, `${path} references gorouter`).not.toMatch(/gorouter/i);
      expect(code, `${path} references tabitoken`).not.toMatch(/tabitoken/i);
    }
  });

  it("hardcodes no deployment origin", () => {
    for (const path of NEW_API_SOURCES) {
      const code = readCode(path);
      expect(code, `${path} hardcodes gorouter.app`).not.toContain("gorouter.app");
      expect(code, `${path} hardcodes tabitoken.com`).not.toContain("tabitoken.com");
    }
  });

  it("leaves no removed native provider modules behind", () => {
    for (const path of [
      "open-sse/providers/registry/gorouter.js",
      "open-sse/providers/registry/tabitoken.js",
      "open-sse/services/gorouter.js",
      "open-sse/services/tabitoken.js",
      "src/lib/gorouter/pairing.js",
    ]) {
      expect(() => readFileSync(join(ROOT, path), "utf8"), path).toThrow();
    }
  });

  it("keeps the registry import list free of them", () => {
    const registry = readCode("open-sse/providers/registry/index.js");
    expect(registry).not.toMatch(/gorouter|tabitoken/i);
  });

  it("routes usage by family, not by a provider-id table entry", () => {
    const usage = readCode("open-sse/services/usage.js");
    // The family hook must run before the static dispatch map lookup.
    expect(usage.indexOf("getNewApiConnectionUsage(connection"))
      .toBeLessThan(usage.indexOf("USAGE_HANDLERS[provider]"));
  });
});
