import { getProviderNodeById, getProviderNodes } from "@/models";
import { createNewApiClientForNode } from "open-sse/services/newapi/resolve.js";
import {
  NEW_API_FAMILY,
  NEW_API_NODE_API_TYPE,
  NEW_API_NODE_TYPE,
  buildNewApiConnectionData,
  deriveNewApiInferenceBaseUrl,
  getNewApiNodeOrigin,
  isNewApiNode,
  isValidNewApiAlias,
  normalizeNewApiOrigin,
  suggestNewApiAlias,
} from "open-sse/services/newapi/definition.js";

/**
 * Server-side New API provider *definition* resolution (custom fork).
 *
 * The single place that turns a provider id into a trusted deployment: reads the
 * persisted provider-node record, confirms it is family `new-api`, and hands back
 * its trusted origin plus a management client. Nothing else in the app should
 * derive a management origin, and no code path should test a literal provider id.
 */

import REGISTRY from "open-sse/providers/registry/index.js";

const MAX_NAME_LENGTH = 100;

/** Provider ids and aliases the compiled-in registry already owns. */
const RESERVED_IDENTIFIERS = (() => {
  const reserved = new Set();
  for (const entry of REGISTRY) {
    if (entry.id) reserved.add(entry.id);
    if (entry.alias) reserved.add(entry.alias);
    if (entry.uiAlias) reserved.add(entry.uiAlias);
    for (const alias of entry.aliases || []) reserved.add(alias);
  }
  // Reserved elsewhere in the fork (see .claude/memory.md): a user-defined prefix
  // must not shadow a local provider-alias override either.
  reserved.add("xmtp");
  return reserved;
})();

/** All New API provider definitions. */
export async function listNewApiProviders() {
  const nodes = await getProviderNodes({ type: NEW_API_NODE_TYPE });
  return nodes.filter(isNewApiNode);
}

/**
 * Resolve one provider id to its New API definition.
 * @returns {Promise<object|null>} the node record, or null when not New API
 */
export async function getNewApiProviderDefinition(providerId) {
  if (typeof providerId !== "string" || !providerId) return null;
  const node = await getProviderNodeById(providerId);
  return isNewApiNode(node) ? node : null;
}

/** Is this provider id a New API provider? */
export async function isNewApiProvider(providerId) {
  return (await getNewApiProviderDefinition(providerId)) !== null;
}

/**
 * Management client for a provider id, built from its persisted trusted origin.
 * @returns {Promise<{ client: object, node: object }|null>}
 */
export async function resolveNewApiProviderClient(providerId) {
  const node = await getNewApiProviderDefinition(providerId);
  if (!node) return null;
  const client = createNewApiClientForNode(node);
  return client ? { client, node } : null;
}

/**
 * Is `alias` free across the compiled-in registry and every existing node?
 * @param {string} alias
 * @param {string|null} [ignoreNodeId] node allowed to keep its own alias
 */
export async function isNewApiAliasAvailable(alias, ignoreNodeId = null) {
  if (!isValidNewApiAlias(alias)) return false;
  if (RESERVED_IDENTIFIERS.has(alias)) return false;
  const nodes = await getProviderNodes();
  return !nodes.some((node) => (
    node.id !== ignoreNodeId && (node.prefix === alias || node.id === alias)
  ));
}

/** First free alias from `base`, `base-2`, … or "" when none is usable. */
export async function allocateNewApiAlias(base, ignoreNodeId = null) {
  const seed = suggestNewApiAlias(base);
  if (!seed) return "";
  if (await isNewApiAliasAvailable(seed, ignoreNodeId)) return seed;
  for (let suffix = 2; suffix < 50; suffix += 1) {
    const candidate = `${seed.slice(0, 29)}-${suffix}`;
    if (await isNewApiAliasAvailable(candidate, ignoreNodeId)) return candidate;
  }
  return "";
}

/**
 * Validate a create request for a New API provider.
 *
 * Returns the exact record to persist, or a user-actionable error. Rejects a
 * duplicate canonical origin so two definitions cannot both own one deployment
 * (which would split its accounts across two provider pools).
 *
 * @returns {Promise<{ ok: true, definition: object } | { ok: false, error: string, status: number }>}
 */
export async function prepareNewApiProviderDefinition({ name, origin, alias }) {
  const cleanName = typeof name === "string" ? name.trim() : "";
  if (!cleanName || cleanName.length > MAX_NAME_LENGTH) {
    return { ok: false, status: 400, error: "Name is required." };
  }

  const normalized = normalizeNewApiOrigin(origin);
  if (!normalized.ok) {
    return { ok: false, status: 400, error: normalized.error };
  }

  const existing = await listNewApiProviders();
  if (existing.some((node) => getNewApiNodeOrigin(node) === normalized.origin)) {
    return { ok: false, status: 409, error: "A New API provider for that origin already exists." };
  }

  const requestedAlias = typeof alias === "string" ? alias.trim().toLowerCase() : "";
  let resolvedAlias;
  if (requestedAlias) {
    if (!isValidNewApiAlias(requestedAlias)) {
      return {
        ok: false,
        status: 400,
        error: "Alias must be lowercase letters, digits or dashes, starting with a letter or digit.",
      };
    }
    if (!(await isNewApiAliasAvailable(requestedAlias))) {
      return { ok: false, status: 409, error: `Alias "${requestedAlias}" is already in use.` };
    }
    resolvedAlias = requestedAlias;
  } else {
    resolvedAlias = await allocateNewApiAlias(cleanName);
    if (!resolvedAlias) {
      return { ok: false, status: 400, error: "Could not derive a free alias from the name — enter one." };
    }
  }

  return {
    ok: true,
    definition: {
      // Reuse the openai-compatible node namespace: New API inference IS
      // OpenAI chat-completions, so every existing compat code path keeps working.
      type: NEW_API_NODE_TYPE,
      apiType: NEW_API_NODE_API_TYPE,
      family: NEW_API_FAMILY,
      name: cleanName,
      prefix: resolvedAlias,
      baseUrl: deriveNewApiInferenceBaseUrl(normalized.origin),
      newApi: { origin: normalized.origin },
    },
  };
}

/**
 * Bounded server-side compatibility probe.
 *
 * `/api/status` is the New API public config endpoint; reaching it proves the
 * origin is a live New API-shaped deployment without demanding a version string
 * or any deployment-specific fingerprint.
 */
export async function probeNewApiOrigin(origin, label = "New API") {
  const normalized = normalizeNewApiOrigin(origin);
  if (!normalized.ok) return { ok: false, error: normalized.error };

  const { createNewApiClient } = await import("open-sse/services/newapi/client.js");
  const client = createNewApiClient({ origin: normalized.origin, label });
  const status = await client.fetchStatus();
  if (!status) {
    return {
      ok: false,
      error: `${normalized.origin} did not answer /api/status — check the domain, or that it is a New API deployment.`,
    };
  }
  return { ok: true, status };
}

export { buildNewApiConnectionData };
