/**
 * Per-provider connection import/export (custom fork feature).
 *
 * Pure serialization + validation logic, deliberately DB-free so both API routes
 * and unit tests can use it. Nothing here logs, and nothing here reads a
 * credential value for any purpose other than copying it.
 */

export const EXPORT_FORMAT = "9router-provider-connections";
export const EXPORT_VERSION = 1;
export const SUPPORTED_VERSIONS = [1];
export const MAX_TRANSFER_CONNECTIONS = 500;

/**
 * Server-controlled / machine-local / transient fields. Everything else on a
 * connection row is copied verbatim, so an unknown custom field still round-trips.
 */
const NON_PORTABLE_FIELDS = [
  "id",          // a fresh uuid is generated on import
  "provider",    // declared once by the wrapper
  "createdAt",
  "updatedAt",
  "priority",    // local ordering; the repo assigns max+1 on create
  "testStatus",
  "lastTested",
  "lastError",
  "lastErrorAt",
  "errorCode",
  "rateLimitedUntil",
  "consecutiveUseCount",
  "lastRefreshAt",
];

/** Credential fields — never echoed in a result summary or an error message. */
export const CREDENTIAL_FIELDS = ["apiKey", "accessToken", "refreshToken", "idToken"];

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Strip non-portable fields; keep everything else, including unknown keys. */
export function serializeConnectionForExport(conn) {
  if (!isPlainObject(conn)) return null;
  const out = {};
  for (const [key, value] of Object.entries(conn)) {
    if (NON_PORTABLE_FIELDS.includes(key)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  if (isPlainObject(conn.providerSpecificData)) {
    out.providerSpecificData = { ...conn.providerSpecificData };
  }
  return out;
}

export function buildExportPayload(provider, connections) {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    provider,
    exportedAt: new Date().toISOString(),
    connections: connections.map(serializeConnectionForExport).filter(Boolean),
  };
}

export function buildExportFilename(provider, date = new Date()) {
  const safeProvider = String(provider || "provider")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".");
  const day = date.toISOString().slice(0, 10);
  return `9router-${safeProvider}-connections-${day}.json`;
}

/**
 * Validate an export wrapper against the provider page it is being imported into.
 * Returns `{ error }` or `{ connections }`.
 */
export function validateImportPayload(payload, expectedProvider) {
  if (!isPlainObject(payload)) return { error: "Import file must be a JSON object" };
  if (payload.format !== EXPORT_FORMAT) {
    return { error: `Unsupported file format (expected "${EXPORT_FORMAT}")` };
  }
  if (!SUPPORTED_VERSIONS.includes(payload.version)) {
    return { error: `Unsupported export version (supported: ${SUPPORTED_VERSIONS.join(", ")})` };
  }
  if (typeof payload.provider !== "string" || !payload.provider) {
    return { error: "Import file is missing a provider" };
  }
  if (expectedProvider && payload.provider !== expectedProvider) {
    return { error: `This file belongs to provider "${payload.provider}", not "${expectedProvider}"` };
  }
  if (!Array.isArray(payload.connections)) {
    return { error: "Import file has no connections array" };
  }
  if (payload.connections.length === 0) {
    return { error: "Import file contains no connections" };
  }
  if (payload.connections.length > MAX_TRANSFER_CONNECTIONS) {
    return { error: `Import file exceeds ${MAX_TRANSFER_CONNECTIONS} connections` };
  }
  return { connections: payload.connections };
}

const OAUTH_AUTH_TYPES = ["oauth", "access_token"];

/**
 * Turn one exported record into `createProviderConnection` input.
 * Returns `{ error }` or `{ data, proxyPoolId }` — the caller decides whether the
 * referenced proxy pool exists locally before re-binding it.
 */
export function prepareConnectionForImport(raw, provider) {
  if (!isPlainObject(raw)) return { error: "Connection entry is not an object" };

  const data = {};
  for (const [key, value] of Object.entries(raw)) {
    if (NON_PORTABLE_FIELDS.includes(key)) continue;
    if (value === undefined) continue;
    data[key] = value;
  }

  const authType = typeof raw.authType === "string" && raw.authType ? raw.authType : "oauth";
  data.provider = provider;
  data.authType = authType;
  data.isActive = raw.isActive === false ? false : true;

  if (raw.name !== undefined && typeof raw.name !== "string") {
    return { error: "Connection name must be a string" };
  }
  if (raw.email !== undefined && raw.email !== null && typeof raw.email !== "string") {
    return { error: "Connection email must be a string" };
  }
  for (const field of CREDENTIAL_FIELDS) {
    if (data[field] !== undefined && data[field] !== null && typeof data[field] !== "string") {
      return { error: `Field ${field} must be a string` };
    }
  }

  let proxyPoolId = null;
  if (isPlainObject(raw.providerSpecificData)) {
    const psd = { ...raw.providerSpecificData };
    if (psd.proxyPoolId !== undefined) {
      proxyPoolId = typeof psd.proxyPoolId === "string" ? psd.proxyPoolId : null;
      delete psd.proxyPoolId;
    }
    data.providerSpecificData = psd;
  } else if (raw.providerSpecificData !== undefined) {
    return { error: "providerSpecificData must be an object" };
  }

  const credentialError = checkCredentials(data, authType, provider);
  if (credentialError) return { error: credentialError };

  return { data, proxyPoolId };
}

function checkCredentials(data, authType, provider) {
  if (provider === "ollama-local") return null;
  if (OAUTH_AUTH_TYPES.includes(authType)) {
    if (!data.accessToken && !data.refreshToken) {
      return "OAuth connection has no accessToken or refreshToken";
    }
    return null;
  }
  if (authType === "apikey" || authType === "cookie") {
    if (!data.apiKey) return `Connection has no ${authType === "cookie" ? "cookie value" : "apiKey"}`;
    return null;
  }
  return null;
}

/**
 * Conservative identity used to SKIP an obvious duplicate rather than overwrite it.
 * `null` means "cannot identify safely" → always create a new connection.
 */
export function connectionIdentityKey(conn) {
  if (!isPlainObject(conn)) return null;
  const authType = conn.authType || "oauth";
  const psd = isPlainObject(conn.providerSpecificData) ? conn.providerSpecificData : {};
  if (authType === "oauth") {
    if (!conn.email) return null;
    const account = psd.chatgptAccountId || psd.username || "";
    return `oauth|${conn.email}|${account}`;
  }
  if (authType === "apikey" || authType === "cookie") {
    if (!conn.name) return null;
    return `${authType}|${conn.name}`;
  }
  return null;
}

/** Strip every credential value from an object destined for a response/log. */
export function redactConnection(conn) {
  if (!isPlainObject(conn)) return conn;
  const out = { ...conn };
  for (const field of CREDENTIAL_FIELDS) delete out[field];
  return out;
}
