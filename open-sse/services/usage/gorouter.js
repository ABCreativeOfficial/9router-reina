import { gorouterClient } from "../gorouter.js";
import { convertNewApiQuota, getNewApiUsage } from "../newapi/usage.js";

/**
 * GoRouter usage adapter — a thin binding over the shared New API quota core.
 * The normalization itself lives in `newapi/usage.js`.
 */

/** @deprecated for new code — prefer convertNewApiQuota. Kept as the GoRouter name. */
export const convertGoRouterQuota = convertNewApiQuota;

export function getGoRouterUsage(accessToken, providerSpecificData = {}, proxyOptions = null) {
  return getNewApiUsage(gorouterClient, accessToken, providerSpecificData, proxyOptions);
}
