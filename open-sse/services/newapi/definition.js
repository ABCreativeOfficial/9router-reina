/**
 * New API provider *definition* helpers (custom fork).
 *
 * A New API provider is a user-created provider node — not a compiled-in
 * registry entry. Everything this layer needs to identify one is derived from
 * two persisted facts:
 *
 *   node.family        === "new-api"      (the definition is a New API provider)
 *   node.newApi.origin === "https://…"    (its trusted management origin)
 *
 * The origin is server-side configuration and is the only management target a
 * request may reach. A browser-supplied origin is never authoritative; it may
 * only be *compared* against the stored one.
 *
 * This module is deliberately pure and dependency-free so both `open-sse/` (usage,
 * clients) and `src/` (routes, bootstrap, and *client* components) can share one
 * contract without pulling a Node-only fetch stack into the browser bundle.
 * Callers that need a management client pair it with `createNewApiClient`.
 */

export const NEW_API_FAMILY = "new-api";

/** New API deployments are OpenAI chat-completions shaped. */
export const NEW_API_NODE_TYPE = "openai-compatible";
export const NEW_API_NODE_API_TYPE = "chat";
export const NEW_API_INFERENCE_PATH = "/v1";

const MAX_ORIGIN_LENGTH = 256;
const MAX_LABEL_LENGTH = 100;
const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Validate a bare https origin and return its canonical form.
 *
 * Rejects http, credentials, a path, a query and a fragment — anything that
 * could smuggle a different target past a later `origin ===` comparison.
 *
 * @param {string} value
 * @returns {{ ok: true, origin: string } | { ok: false, error: string }}
 */
export function normalizeNewApiOrigin(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.length > MAX_ORIGIN_LENGTH) {
    return { ok: false, error: "Origin is required." };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "Origin must be a valid URL, e.g. https://example.com" };
  }

  if (url.protocol !== "https:") {
    return { ok: false, error: "Origin must use https." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Origin must not contain credentials." };
  }
  if (url.search) {
    return { ok: false, error: "Origin must not contain a query string." };
  }
  if (url.hash) {
    return { ok: false, error: "Origin must not contain a fragment." };
  }
  // `new URL("https://example.com")` normalizes pathname to "/", so only a real
  // path segment is a rejection.
  if (url.pathname && url.pathname !== "/") {
    return { ok: false, error: "Origin must not contain a path — use https://example.com, not https://example.com/v1" };
  }
  if (!url.hostname) {
    return { ok: false, error: "Origin must include a host." };
  }

  return { ok: true, origin: url.origin };
}

/** Inference base URL derived from the origin. The user never types `/v1`. */
export function deriveNewApiInferenceBaseUrl(origin) {
  return `${String(origin).replace(/\/+$/, "")}${NEW_API_INFERENCE_PATH}`;
}

/** A provider *alias* (node prefix) must be a safe, lowercase model-id prefix. */
export function isValidNewApiAlias(alias) {
  return typeof alias === "string" && ALIAS_PATTERN.test(alias);
}

/** Best-effort alias from a display name; caller still resolves collisions. */
export function suggestNewApiAlias(name) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return isValidNewApiAlias(slug) ? slug : "";
}

/** Is this provider-node record a New API provider definition? */
export function isNewApiNode(node) {
  return !!node
    && node.family === NEW_API_FAMILY
    && normalizeNewApiOrigin(node?.newApi?.origin).ok;
}

/** Trusted origin of a New API node, or "" when the node is not one. */
export function getNewApiNodeOrigin(node) {
  const normalized = normalizeNewApiOrigin(node?.newApi?.origin);
  return node?.family === NEW_API_FAMILY && normalized.ok ? normalized.origin : "";
}

/**
 * `providerSpecificData` fragment a New API connection carries.
 *
 * Mirrors the existing compatible-node convention (`prefix`/`apiType`/`baseUrl`/
 * `nodeName` are copied onto the connection and re-synced when the node changes)
 * and adds the two New API fields. The node record stays authoritative; this is
 * the cache that lets provider-agnostic layers — the usage dispatcher inside
 * `open-sse/`, which has no DB access — recognise and reach the deployment.
 */
export function buildNewApiConnectionData(node) {
  const origin = getNewApiNodeOrigin(node);
  if (!origin) return null;
  return {
    prefix: node.prefix,
    apiType: NEW_API_NODE_API_TYPE,
    baseUrl: deriveNewApiInferenceBaseUrl(origin),
    nodeName: node.name,
    newApiOrigin: origin,
    newApiLabel: String(node.name || "New API").slice(0, MAX_LABEL_LENGTH),
  };
}

/** Trusted New API config carried by a connection, or null. */
export function readNewApiConnectionConfig(connection) {
  const normalized = normalizeNewApiOrigin(connection?.providerSpecificData?.newApiOrigin);
  if (!normalized.ok) return null;
  const label = connection.providerSpecificData?.newApiLabel;
  return {
    origin: normalized.origin,
    label: (typeof label === "string" && label.trim()) || "New API",
  };
}

/** Family check for a *connection* — the provider id is never consulted. */
export function isNewApiConnection(connection) {
  return readNewApiConnectionConfig(connection) !== null;
}
