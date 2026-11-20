import { createHash } from "node:crypto";
import { KIRO_IDE_VERSION, KIRO_CLI_VERSION } from "./kiroClientVersions.js";

// Published Kiro releases on 2026-11-18 (IDE) and 2026-11-17 (CLI).
// Kiro validates its client version upstream; the IDE and CLI version tracks
// are independent. Update these together with the official changelogs.
export { KIRO_IDE_VERSION, KIRO_CLI_VERSION } from "./kiroClientVersions.js";

const SDK_VERSION = "1.0.0";
const OS_VERSION = "10.0.26200";
const NODE_VERSION = "22.21.1";

/** Stable, opaque account identifier. Never put a credential in a UA verbatim. */
export function getKiroMachineId(credentials = {}) {
  const psd = credentials?.providerSpecificData || {};
  const seed = psd.machineId || psd.clientId || credentials?.refreshToken ||
    psd.profileArn || credentials?.accessToken || credentials?.apiKey || "kiro-anonymous";
  return createHash("sha256").update(String(seed)).digest("hex");
}

/** Shared IDE identity for inference, catalog, usage and API-key validation. */
export function buildKiroIdeHeaders(credentials = {}, api = "codewhispererruntime") {
  const service = api === "codewhispererstreaming" ? "codewhispererstreaming" : "codewhispererruntime";
  const metrics = service === "codewhispererstreaming" ? "m/E" : "m/N,E";
  const suffix = `KiroIDE-${KIRO_IDE_VERSION}-${getKiroMachineId(credentials)}`;
  return {
    "User-Agent": `aws-sdk-js/${SDK_VERSION} ua/2.1 os/windows#${OS_VERSION} ` +
      `lang/js md/nodejs#${NODE_VERSION} api/${service}#${SDK_VERSION} ${metrics} ${suffix}`,
    "X-Amz-User-Agent": `aws-sdk-js/${SDK_VERSION} ${suffix}`,
  };
}

export function buildKiroCliUserAgent() {
  return `kiro-cli/${KIRO_CLI_VERSION}`;
}

const OBSOLETE_CLIENT_RE = /kiro-ide\/1\.0\.0|KiroIDE-0\.10\.32|kiro-cli\/1\.0\.0|^aws-sdk-js\/1\.0\.0\s+KiroIDE\s*$/i;

/**
 * Reconcile user overrides after BaseExecutor's header merge. Respect a modern
 * explicit override, but silently retire legacy 9Router defaults and avoid
 * case-variant duplicate headers (which fetch would combine with commas).
 */
export function finalizeKiroIdeHeaders(headers, credentials, api, overrides = {}) {
  const defaults = buildKiroIdeHeaders(credentials, api);
  for (const [name, value] of Object.entries(defaults)) {
    const override = Object.entries(overrides || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
    const chosen = override && !OBSOLETE_CLIENT_RE.test(String(override[1])) && String(override[1]).trim()
      ? override[1]
      : value;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
    }
    headers[name] = chosen;
  }
  return headers;
}
