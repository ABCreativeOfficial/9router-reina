import { tabitokenClient } from "../tabitoken.js";
import { getNewApiUsage } from "../newapi/usage.js";

/**
 * TabiToken usage adapter — a thin binding over the shared New API quota core.
 * The normalization itself lives in `newapi/usage.js`.
 */
export function getTabiTokenUsage(accessToken, providerSpecificData = {}, proxyOptions = null) {
  return getNewApiUsage(tabitokenClient, accessToken, providerSpecificData, proxyOptions);
}
