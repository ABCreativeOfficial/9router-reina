/**
 * Per-account (per-connection) model access policy.
 *
 * Canonical storage is `connection.providerSpecificData.enabledModels` — the same
 * array `/v1/models` already consumes. There is deliberately no second field.
 *
 * Semantics (backward compatible with every pre-existing connection):
 *   - missing / not an array / empty  -> no restriction, connection participates as before
 *   - non-empty array                 -> connection is eligible ONLY for those model ids
 */

import { getProviderAlias } from "@/shared/constants/providers";
import { getProviderConnections } from "@/lib/localDb";

// Guard against a runaway payload; generous enough for the largest provider catalogs.
export const MAX_ENABLED_MODELS = 500;

/**
 * Normalize a user-supplied model allowlist: strings only, trimmed, no blanks, deduped, capped.
 * @param {unknown} input
 * @returns {string[]}
 */
export function sanitizeEnabledModels(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of input) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_ENABLED_MODELS) break;
  }
  return out;
}

/** @returns {string[]} the connection's allowlist, sanitized ([] means "no restriction"). */
export function getEnabledModels(connection) {
  return sanitizeEnabledModels(connection?.providerSpecificData?.enabledModels);
}

/** @returns {boolean} true when this connection explicitly restricts its models. */
export function hasModelRestriction(connection) {
  return getEnabledModels(connection).length > 0;
}

/**
 * Prefixes an allowlist entry may legitimately carry for this connection.
 * `/v1/models` emits ids as `<outputAlias>/<model>`, so a value copied from there
 * must still match the bare model id the router asks for.
 */
function prefixCandidates(connection) {
  const providerId = connection?.provider;
  return [
    connection?.providerSpecificData?.prefix,
    providerId,
    providerId ? getProviderAlias(providerId) : null,
  ].filter((p) => typeof p === "string" && p.trim() !== "");
}

/** Strip a leading `<knownPrefix>/` from a model id. Model ids may themselves contain `/`. */
function stripProviderPrefix(modelId, prefixes) {
  for (const prefix of prefixes) {
    if (modelId.startsWith(`${prefix}/`)) return modelId.slice(prefix.length + 1);
  }
  return modelId;
}

/**
 * Is this connection allowed to serve `model`?
 * Exact id match only (after provider-prefix normalization) — no fuzzy/substring matching.
 * @param {object} connection - raw provider connection record
 * @param {string|null} model - model id as the router resolved it (no provider prefix)
 * @returns {boolean}
 */
export function isConnectionEligibleForModel(connection, model) {
  const allowed = getEnabledModels(connection);
  if (allowed.length === 0) return true;          // no policy -> legacy behavior
  if (!model) return true;                        // model-less lookup (e.g. web search) -> unchanged
  const prefixes = prefixCandidates(connection);
  const requested = stripProviderPrefix(String(model).trim(), prefixes);
  return allowed.some((entry) => stripProviderPrefix(entry, prefixes) === requested);
}

/**
 * Union of model ids reachable through the given connections, for `/v1/models` visibility.
 * A model stays visible while at least one account can serve it.
 * @param {object[]} connections - active connections of one provider
 * @returns {{ allRestricted: boolean, allowedUnion: string[] }}
 */
export function collectProviderModelVisibility(connections) {
  const list = Array.isArray(connections) ? connections : [];
  const allowedUnion = [];
  const seen = new Set();
  let allRestricted = list.length > 0;

  for (const conn of list) {
    const allowed = getEnabledModels(conn);
    if (allowed.length === 0) {
      allRestricted = false;
      continue;
    }
    for (const id of allowed) {
      if (seen.has(id)) continue;
      seen.add(id);
      allowedUnion.push(id);
    }
  }

  return { allRestricted, allowedUnion };
}

/**
 * Distinguish "provider has no accounts at all" from "every account is barred from this model",
 * for the client-facing error after getProviderCredentials() returned null.
 * @param {string} providerId - resolved provider id
 * @param {string|null} model
 * @returns {Promise<string|null>} reason message, or null when the policy is not the cause
 */
export async function describeNoEligibleAccountForModel(providerId, model) {
  if (!model) return null;
  let connections;
  try {
    connections = await getProviderConnections({ provider: providerId, isActive: true });
  } catch {
    return null;
  }
  if (!connections?.length) return null;
  if (connections.some((c) => isConnectionEligibleForModel(c, model))) return null;
  return `no_eligible_account_for_model: no active ${providerId} account is enabled for model "${model}"`;
}
