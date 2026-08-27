import { createProviderConnection, getProviderConnections, updateProviderConnection } from "@/models";
import { normalizeNewApiUserId } from "open-sse/services/newapi/client.js";

/**
 * Shared server-side New API onboarding (custom fork feature).
 *
 * Extracted once GoRouter and TabiToken proved the flow identical: validate the
 * management credential, list existing inference tokens, retrieve the selected
 * full key server-side, discover models, then create or reconnect a connection.
 * A deployment supplies its provider id, label, client, and naming rule.
 *
 * Nothing here returns a credential to its caller. It must live app-side rather
 * than under `open-sse/` because it writes through `@/models`.
 */

const MAX_NAME_LENGTH = 200;

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
 * `state` is `needs_token_creation` when the account has no usable token, so the
 * caller can require an explicit user action instead of creating one silently.
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

  const usable = listed.tokens.filter((token) => token.status === client.activeStatus);
  return {
    ok: true,
    account: validation.account,
    tokens: listed.tokens,
    state: usable.length > 0 ? "ready" : "needs_token_creation",
  };
}

/**
 * Complete onboarding for one already-validated account.
 *
 * Reconnect (an existing connection for this account id) updates that row in
 * place, preserving `providerSpecificData.enabledModels` and priority, and never
 * renames it — the stored name may be user-customized. A new account always
 * creates a fresh row and never overwrites another account.
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
}) {
  const inspected = inspection
    || await inspectNewApiAccount({ client, managementToken, userId, proxyOptions });
  if (!inspected.ok) return inspected;

  const selection = selectNewApiToken(inspected.tokens, tokenId, {
    label: client.label,
    activeStatus: client.activeStatus,
  });
  if (!selection.ok) {
    return inspected.state === "needs_token_creation"
      ? {
        ok: false,
        status: 409,
        state: "needs_token_creation",
        message: `No suitable existing ${client.label} inference token.`,
      }
      : selection;
  }

  const [keyResult, modelsResult] = await Promise.all([
    client.retrieveTokenKey(managementToken, userId, selection.token.id, proxyOptions),
    client.fetchModels(managementToken, userId, proxyOptions),
  ]);
  if (!keyResult.ok) {
    return { ok: false, status: keyResult.status || 502, message: `Selected ${client.label} token is unavailable.` };
  }
  if (!modelsResult.ok) {
    return { ok: false, status: modelsResult.status || 502, message: `${client.label} model list could not be fetched.` };
  }

  const inferenceValidation = await client.validateInferenceKey(keyResult.apiKey, proxyOptions);
  if (!inferenceValidation.ok) {
    return {
      ok: false,
      status: inferenceValidation.status || 502,
      message: `Selected ${client.label} token is unavailable.`,
    };
  }

  const account = inspected.account;
  const existing = await findNewApiConnectionByUserId(providerId, account.id);

  if (existing) {
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
    return { ok: true, created: false, connection: updated || existing, models: modelsResult.models, account };
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
