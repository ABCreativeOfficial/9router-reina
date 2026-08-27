import { createProviderConnection, getProviderConnections, updateProviderConnection } from "@/models";
import {
  fetchGoRouterModels,
  listGoRouterTokens,
  normalizeGoRouterUserId,
  retrieveGoRouterTokenKey,
  validateGoRouterInferenceKey,
  validateGoRouterManagementCredentials,
} from "open-sse/services/gorouter.js";

/**
 * Shared server-side GoRouter onboarding (custom fork feature).
 *
 * The manual credential form and the Chrome-bridge pairing flow both land here,
 * so the validation gates, token selection, and connection identity rules exist
 * exactly once. Nothing in this module returns a credential to its caller.
 */

const PROVIDER_ID = "gorouter";
const MAX_NAME_LENGTH = 200;

/** Trim a caller-supplied connection name, falling back when unusable. */
export function cleanConnectionName(value, fallback) {
  if (typeof value !== "string") return fallback;
  const name = value.trim();
  return name && name.length <= MAX_NAME_LENGTH ? name : fallback;
}

/**
 * Initial name for a NEW connection: the account's own identity, never the
 * selected inference token's name (a token is a credential, not an account).
 */
export function buildGoRouterConnectionName({ requested, account, existingNames = [] }) {
  const fallback = account?.displayName || account?.username || `GoRouter ${account?.id}`;
  const base = cleanConnectionName(requested, fallback);
  const taken = new Set(existingNames.filter(Boolean));
  if (!taken.has(base)) return base;
  // The repo dedupes apikey connections by name alone, so a colliding name would
  // silently overwrite a *different* GoRouter account. Uniquify instead.
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base} (${suffix})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/** Existing connection for this GoRouter account id, or null. */
export async function findGoRouterConnectionByUserId(userId) {
  const normalized = normalizeGoRouterUserId(userId);
  if (!normalized) return null;
  const connections = await getProviderConnections({ provider: PROVIDER_ID });
  return connections.find(
    (connection) => normalizeGoRouterUserId(connection.providerSpecificData?.userId) === normalized,
  ) || null;
}

/** Pure: is this token id usable? */
export function selectGoRouterToken(tokens, tokenId) {
  const id = Number(tokenId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return { ok: false, status: 400, message: "Selected GoRouter token is unavailable." };
  }
  const token = (tokens || []).find((entry) => entry.id === id);
  if (!token || token.status !== 1) {
    return { ok: false, status: 400, message: "Selected GoRouter token is unavailable." };
  }
  return { ok: true, token };
}

/**
 * Validate management credentials and list the account's inference tokens.
 * `state` is `needs_token_creation` when the account has no usable token, so the
 * caller can require an explicit user action instead of creating one silently.
 */
export async function inspectGoRouterAccount({ managementToken, userId, proxyOptions = null }) {
  const validation = await validateGoRouterManagementCredentials(managementToken, userId, proxyOptions);
  if (!validation.ok) {
    return { ok: false, status: validation.status || 401, message: "GoRouter management authentication failed." };
  }

  const listed = await listGoRouterTokens(managementToken, userId, proxyOptions);
  if (!listed.ok) {
    return { ok: false, status: listed.status || 502, message: "Unable to retrieve GoRouter API tokens." };
  }

  const usable = listed.tokens.filter((token) => token.status === 1);
  return {
    ok: true,
    account: validation.account,
    tokens: listed.tokens,
    state: usable.length > 0 ? "ready" : "needs_token_creation",
  };
}

/**
 * Complete onboarding for one already-validated account: retrieve the selected
 * inference key server-side, discover models, then persist.
 *
 * Reconnect (an existing connection for this account id) updates that row in
 * place, preserving `providerSpecificData.enabledModels` and priority. A new
 * account always creates a fresh row and never overwrites another account.
 */
export async function connectGoRouterAccount({
  managementToken,
  userId,
  tokenId,
  name,
  proxyOptions = null,
  inspection = null,
}) {
  const inspected = inspection || await inspectGoRouterAccount({ managementToken, userId, proxyOptions });
  if (!inspected.ok) return inspected;

  const selection = selectGoRouterToken(inspected.tokens, tokenId);
  if (!selection.ok) {
    return inspected.state === "needs_token_creation"
      ? { ok: false, status: 409, state: "needs_token_creation", message: "No suitable existing GoRouter inference token." }
      : selection;
  }

  const [keyResult, modelsResult] = await Promise.all([
    retrieveGoRouterTokenKey(managementToken, userId, selection.token.id, proxyOptions),
    fetchGoRouterModels(managementToken, userId, proxyOptions),
  ]);
  if (!keyResult.ok) {
    return { ok: false, status: keyResult.status || 502, message: "Selected GoRouter token is unavailable." };
  }
  if (!modelsResult.ok) {
    return { ok: false, status: modelsResult.status || 502, message: "GoRouter model list could not be fetched." };
  }

  const inferenceValidation = await validateGoRouterInferenceKey(keyResult.apiKey, proxyOptions);
  if (!inferenceValidation.ok) {
    return { ok: false, status: inferenceValidation.status || 502, message: "Selected GoRouter token is unavailable." };
  }

  const account = inspected.account;
  const existing = await findGoRouterConnectionByUserId(account.id);

  if (existing) {
    // Reconnect re-authenticates in place and never renames: the stored name may
    // have been customized by the user, and the account identity has not changed.
    const updated = await updateProviderConnection(existing.id, {
      apiKey: keyResult.apiKey,
      accessToken: String(managementToken).trim(),
      // Shallow replace: spread the stored blob so enabledModels survives.
      providerSpecificData: { ...(existing.providerSpecificData || {}), userId: account.id },
      isActive: true,
      testStatus: "active",
      lastError: null,
      lastErrorAt: null,
    });
    return {
      ok: true,
      created: false,
      connection: updated || existing,
      models: modelsResult.models,
      account,
    };
  }

  const connections = await getProviderConnections({ provider: PROVIDER_ID });
  const connection = await createProviderConnection({
    provider: PROVIDER_ID,
    authType: "apikey",
    name: buildGoRouterConnectionName({
      requested: name,
      account,
      existingNames: connections.map((entry) => entry.name),
    }),
    apiKey: keyResult.apiKey,
    accessToken: String(managementToken).trim(),
    providerSpecificData: { userId: account.id },
    isActive: true,
    testStatus: "active",
  });

  return { ok: true, created: true, connection, models: modelsResult.models, account };
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
