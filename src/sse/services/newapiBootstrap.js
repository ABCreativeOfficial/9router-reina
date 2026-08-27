import crypto from "node:crypto";
import { createProviderConnection, getProviderConnections, updateProviderConnection } from "@/models";
import { normalizeNewApiUserId } from "open-sse/services/newapi/client.js";
import {
  buildAutoTokenName,
  isUsableNewApiToken,
  sortNewApiTokenCandidates,
} from "open-sse/services/newapi/tokenPolicy.js";

/**
 * Shared server-side New API onboarding (custom fork feature).
 *
 * Provider-neutral: a caller supplies the provider id, the management client
 * built from the definition's trusted origin, and the credentials. The flow is
 * validate management token → canonical account identity → choose or create a
 * usable inference token → retrieve and validate the full key → discover models
 * → create or reconnect a connection.
 *
 * Nothing here returns a credential to its caller. It must live app-side rather
 * than under `open-sse/` because it writes through `@/models`.
 */

const MAX_NAME_LENGTH = 200;
const MAX_TOKEN_CANDIDATES = 5;

/** Trim a caller-supplied connection name, falling back when unusable. */
export function cleanConnectionName(value, fallback) {
  if (typeof value !== "string") return fallback;
  const name = value.trim();
  return name && name.length <= MAX_NAME_LENGTH ? name : fallback;
}

/**
 * Initial name for a NEW connection: the account's own identity, never the
 * selected inference token's name (a token is a credential, not an account —
 * a shared token name would otherwise label every account identically).
 */
export function buildNewApiConnectionName({ requested, account, label, existingNames = [] }) {
  const fallback = account?.displayName || account?.username || `${label} ${account?.id}`;
  const base = cleanConnectionName(requested, fallback);
  const taken = new Set(existingNames.filter(Boolean));
  if (!taken.has(base)) return base;
  // The repo dedupes apikey connections by name alone, so a colliding name would
  // silently overwrite a *different* account. Uniquify instead.
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base} (${suffix})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/** Existing connection of `providerId` for this account id, or null. */
export async function findNewApiConnectionByUserId(providerId, userId) {
  const normalized = normalizeNewApiUserId(userId);
  if (!normalized) return null;
  const connections = await getProviderConnections({ provider: providerId });
  return connections.find(
    (connection) => normalizeNewApiUserId(connection.providerSpecificData?.userId) === normalized,
  ) || null;
}

/** Pure: is this token id usable? */
export function selectNewApiToken(tokens, tokenId, { label = "New API", activeStatus = 1 } = {}) {
  const id = Number(tokenId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return { ok: false, status: 400, message: `Selected ${label} token is unavailable.` };
  }
  const token = (tokens || []).find((entry) => entry.id === id);
  if (!token || token.status !== activeStatus) {
    return { ok: false, status: 400, message: `Selected ${label} token is unavailable.` };
  }
  return { ok: true, token };
}

/**
 * Validate management credentials and list the account's inference tokens.
 *
 * `state` reports whether a usable token already exists. It is metadata for the
 * manual/advanced UI only — the automatic path (`ensureNewApiInferenceKey`)
 * creates one when none does, so `needs_token_creation` is no longer a
 * user-facing dead end.
 */
export async function inspectNewApiAccount({ client, managementToken, userId, proxyOptions = null }) {
  const validation = await client.getAccount(managementToken, userId, proxyOptions);
  if (!validation.ok) {
    return { ok: false, status: validation.status || 401, message: `${client.label} management authentication failed.` };
  }

  const listed = await client.listTokens(managementToken, userId, proxyOptions);
  if (!listed.ok) {
    return { ok: false, status: listed.status || 502, message: `Unable to retrieve ${client.label} API tokens.` };
  }

  const usable = listed.tokens.filter(
    (token) => isUsableNewApiToken(token, { activeStatus: client.activeStatus }),
  );
  return {
    ok: true,
    account: validation.account,
    tokens: listed.tokens,
    state: usable.length > 0 ? "ready" : "needs_token_creation",
  };
}

/**
 * Retrieve a full key for one token id and prove it against the inference API.
 * Failure is expected (stale metadata), so it returns a plain boolean-ish result.
 */
async function resolveValidatedKey({ client, managementToken, userId, tokenId, proxyOptions }) {
  const keyResult = await client.retrieveTokenKey(managementToken, userId, tokenId, proxyOptions);
  if (!keyResult.ok) return null;
  const validation = await client.validateInferenceKey(keyResult.apiKey, proxyOptions);
  return validation.ok ? keyResult.apiKey : null;
}

/**
 * Guarantee a usable inference key for an already-validated account.
 *
 * 1. Try usable existing tokens in `accessed_time desc → created_time desc →
 *    id desc` order, so the account's most recently *used* credential wins.
 * 2. If none yields a validated key, create one token dedicated to 9Router.
 *
 * Upstream's create endpoint returns no id, so creation re-lists and matches the
 * unique generated name. The key is never returned to a client and never logged.
 *
 * @returns {{ ok: true, apiKey: string, created: boolean, tokenId: number }
 *          | { ok: false, status: number, message: string }}
 */
export async function ensureNewApiInferenceKey({
  client,
  managementToken,
  userId,
  tokens = [],
  preferredTokenId = null,
  proxyOptions = null,
}) {
  const candidates = sortNewApiTokenCandidates(tokens, { activeStatus: client.activeStatus });

  // An explicit user choice (advanced manual flow) is tried first, but still has
  // to pass key retrieval and inference validation like any other candidate.
  const preferred = Number(preferredTokenId);
  const ordered = Number.isSafeInteger(preferred) && preferred > 0
    ? [
      ...candidates.filter((token) => token.id === preferred),
      ...candidates.filter((token) => token.id !== preferred),
    ]
    : candidates;

  for (const token of ordered.slice(0, MAX_TOKEN_CANDIDATES)) {
    const apiKey = await resolveValidatedKey({
      client, managementToken, userId, tokenId: token.id, proxyOptions,
    });
    if (apiKey) return { ok: true, apiKey, created: false, tokenId: token.id };
  }

  const name = buildAutoTokenName(crypto.randomBytes(4).toString("hex"));
  const creation = await client.createToken(managementToken, userId, { name, proxyOptions });
  if (!creation.ok) {
    return { ok: false, status: creation.status || 502, message: creation.message };
  }

  const relisted = await client.listTokens(managementToken, userId, proxyOptions);
  if (!relisted.ok) {
    return { ok: false, status: relisted.status || 502, message: `Unable to retrieve ${client.label} API tokens.` };
  }
  // Exact name match: the suffix is random per attempt, so this cannot pick up a
  // pre-existing token or another concurrent creation.
  const createdMatches = relisted.tokens.filter((token) => token.name === name);
  const created = createdMatches.length === 1 ? createdMatches[0] : null;
  if (!created) {
    return { ok: false, status: 502, message: `${client.label} did not report the created API token.` };
  }

  const apiKey = await resolveValidatedKey({
    client, managementToken, userId, tokenId: created.id, proxyOptions,
  });
  if (!apiKey) {
    return { ok: false, status: 502, message: `The new ${client.label} API token could not be verified.` };
  }
  return { ok: true, apiKey, created: true, tokenId: created.id };
}

/**
 * Complete onboarding for one already-validated account.
 *
 * A usable inference token is guaranteed automatically — chosen from the
 * account's existing tokens, or created when none works. Reconnect (an existing
 * connection for this account id) updates that row in place, preserving
 * `providerSpecificData.enabledModels` and priority, and never renames it — the
 * stored name may be user-customized. A new account always creates a fresh row
 * and never overwrites another account.
 *
 * @param {object}  params
 * @param {object}  params.client          management client for the trusted origin
 * @param {string}  params.providerId      provider id the connection belongs to
 * @param {number}  [params.tokenId]       optional user-chosen token (still validated)
 * @param {object}  [params.connectionData] extra providerSpecificData to persist
 *                                          (a New API definition's origin/label/prefix)
 */
export async function connectNewApiAccount({
  client,
  providerId,
  managementToken,
  userId,
  tokenId,
  name,
  proxyOptions = null,
  inspection = null,
  connectionData = null,
}) {
  const inspected = inspection
    || await inspectNewApiAccount({ client, managementToken, userId, proxyOptions });
  if (!inspected.ok) return inspected;

  const keyResult = await ensureNewApiInferenceKey({
    client,
    managementToken,
    userId,
    tokens: inspected.tokens,
    preferredTokenId: tokenId,
    proxyOptions,
  });
  if (!keyResult.ok) return keyResult;

  const modelsResult = await client.fetchModels(managementToken, userId, proxyOptions);
  if (!modelsResult.ok) {
    return { ok: false, status: modelsResult.status || 502, message: `${client.label} model list could not be fetched.` };
  }

  const account = inspected.account;
  const existing = await findNewApiConnectionByUserId(providerId, account.id);
  const extraData = connectionData && typeof connectionData === "object" ? connectionData : {};

  if (existing) {
    const updated = await updateProviderConnection(existing.id, {
      apiKey: keyResult.apiKey,
      accessToken: String(managementToken).trim(),
      // Shallow replace: spread the stored blob so enabledModels survives.
      providerSpecificData: { ...(existing.providerSpecificData || {}), ...extraData, userId: account.id },
      isActive: true,
      testStatus: "active",
      lastError: null,
      lastErrorAt: null,
    });
    return {
      ok: true,
      created: false,
      tokenCreated: keyResult.created,
      connection: updated || existing,
      models: modelsResult.models,
      account,
    };
  }

  const connections = await getProviderConnections({ provider: providerId });
  const connection = await createProviderConnection({
    provider: providerId,
    authType: "apikey",
    name: buildNewApiConnectionName({
      requested: name,
      account,
      label: client.label,
      existingNames: connections.map((entry) => entry.name),
    }),
    apiKey: keyResult.apiKey,
    accessToken: String(managementToken).trim(),
    providerSpecificData: { ...extraData, userId: account.id },
    isActive: true,
    testStatus: "active",
  });

  return {
    ok: true,
    created: true,
    tokenCreated: keyResult.created,
    connection,
    models: modelsResult.models,
    account,
  };
}

/** Connection metadata safe to return over HTTP. */
export function safeConnectionSummary(connection, account) {
  return {
    id: connection.id,
    provider: connection.provider,
    name: connection.name,
    authType: connection.authType,
    providerSpecificData: { userId: account.id },
  };
}
