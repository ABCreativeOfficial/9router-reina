import { tabitokenClient } from "open-sse/services/tabitoken.js";
import {
  connectNewApiAccount,
  inspectNewApiAccount,
  safeConnectionSummary,
} from "@/sse/services/newapiBootstrap";

/**
 * TabiToken binding over the shared New API onboarding core.
 * All gates, token selection, and connection identity rules are the shared ones.
 */

const PROVIDER_ID = "tabitoken";

export { safeConnectionSummary };

export function inspectTabiTokenAccount({ managementToken, userId, proxyOptions = null }) {
  return inspectNewApiAccount({ client: tabitokenClient, managementToken, userId, proxyOptions });
}

export function connectTabiTokenAccount({
  managementToken,
  userId,
  tokenId,
  name,
  proxyOptions = null,
  inspection = null,
}) {
  return connectNewApiAccount({
    client: tabitokenClient,
    providerId: PROVIDER_ID,
    managementToken,
    userId,
    tokenId,
    name,
    proxyOptions,
    inspection,
  });
}
