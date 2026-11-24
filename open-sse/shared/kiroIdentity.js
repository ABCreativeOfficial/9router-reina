import { createHash } from "crypto";
import {
  KIRO_IDE_VERSION,
  KIRO_SDK_VERSION,
  KIRO_AGENT_OS,
  KIRO_AGENT_OS_VERSION,
  KIRO_NODE_VERSION,
  KIRO_SDK_CLIENTS,
} from "../config/kiroClient.js";

/**
 * The User-Agent pair the Kiro IDE sends, shared by every Kiro / Amazon Q call so
 * no caller can fall below Kiro's client-version gate on its own (#5613).
 *
 * The machine id is a sha256 of the account's most stable identifier: a rotating
 * access token keeps the same id, and no raw credential reaches the header.
 *
 * @param {object} [credentials] { accessToken, refreshToken, apiKey, providerSpecificData }
 * @param {"streaming"|"runtime"} [client] AWS SDK client the call belongs to
 */
export function buildKiroIdentityHeaders(credentials, client = "runtime") {
  const seed =
    credentials?.providerSpecificData?.clientId
    || credentials?.refreshToken
    || credentials?.providerSpecificData?.profileArn
    || credentials?.apiKey
    || credentials?.accessToken
    || "kiro-anonymous";
  const machineId = createHash("sha256").update(String(seed)).digest("hex");
  const { api, metrics } = KIRO_SDK_CLIENTS[client] || KIRO_SDK_CLIENTS.runtime;
  const identity = `KiroIDE-${KIRO_IDE_VERSION}-${machineId}`;

  return {
    "User-Agent":
      `aws-sdk-js/${KIRO_SDK_VERSION} ua/2.1 ` +
      `os/${KIRO_AGENT_OS}#${KIRO_AGENT_OS_VERSION} ` +
      `lang/js md/nodejs#${KIRO_NODE_VERSION} ` +
      `api/${api}#${KIRO_SDK_VERSION} m/${metrics} ${identity}`,
    "X-Amz-User-Agent": `aws-sdk-js/${KIRO_SDK_VERSION} ${identity}`,
  };
}

/** Stable, opaque account id (sha256 of the most stable identifier). */
export function getKiroMachineId(credentials = {}) {
  const psd = credentials?.providerSpecificData || {};
  const seed = psd.machineId || psd.clientId || credentials?.refreshToken ||
    psd.profileArn || credentials?.accessToken || credentials?.apiKey || "kiro-anonymous";
  return createHash("sha256").update(String(seed)).digest("hex");
}

// Provider-supplied header overrides never get to downgrade the identity: an
// obsolete client string would trip Kiro's version gate, so the canonical value wins.
const OBSOLETE_CLIENT_RE = /kiro-ide\/1\.0\.0|KiroIDE-0\.10\.32|kiro-cli\/1\.0\.0|^aws-sdk-js\/1\.0\.0\s+KiroIDE\s*$/i;

export function finalizeKiroIdeHeaders(headers, credentials, api, overrides = {}) {
  const defaults = buildKiroIdentityHeaders(credentials, api === "codewhispererstreaming" ? "streaming" : "runtime");
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
