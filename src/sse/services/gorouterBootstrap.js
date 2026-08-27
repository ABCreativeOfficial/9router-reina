import { gorouterClient } from "open-sse/services/gorouter.js";
import {
  buildNewApiConnectionName,
  cleanConnectionName,
  connectNewApiAccount,
  findNewApiConnectionByUserId,
  inspectNewApiAccount,
  safeConnectionSummary,
  selectNewApiToken,
} from "@/sse/services/newapiBootstrap";

/**
 * GoRouter binding over the shared New API onboarding core.
 *
 * The manual credential form and the Chrome-bridge pairing flow both land here,
 * so GoRouter's validation gates, token selection, and connection identity rules
 * stay exactly where they were while the logic itself is shared with TabiToken.
 */

const PROVIDER_ID = "gorouter";

export { cleanConnectionName, safeConnectionSummary };

export function buildGoRouterConnectionName({ requested, account, existingNames = [] }) {
  return buildNewApiConnectionName({ requested, account, label: gorouterClient.label, existingNames });
}

export function findGoRouterConnectionByUserId(userId) {
  return findNewApiConnectionByUserId(PROVIDER_ID, userId);
}

export function selectGoRouterToken(tokens, tokenId) {
  return selectNewApiToken(tokens, tokenId, {
    label: gorouterClient.label,
    activeStatus: gorouterClient.activeStatus,
  });
}

export function inspectGoRouterAccount({ managementToken, userId, proxyOptions = null }) {
  return inspectNewApiAccount({ client: gorouterClient, managementToken, userId, proxyOptions });
}

export function connectGoRouterAccount({
  managementToken,
  userId,
  tokenId,
  name,
  proxyOptions = null,
  inspection = null,
}) {
  return connectNewApiAccount({
    client: gorouterClient,
    providerId: PROVIDER_ID,
    managementToken,
    userId,
    tokenId,
    name,
    proxyOptions,
    inspection,
  });
}
