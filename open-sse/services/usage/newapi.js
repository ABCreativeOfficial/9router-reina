import { createNewApiClientForConnection } from "../newapi/resolve.js";
import { getNewApiUsage } from "../newapi/usage.js";

/**
 * New API usage adapter (custom fork) — family-based, not provider-id based.
 *
 * A New API connection carries its deployment's trusted origin and label in
 * `providerSpecificData` (written by the shared bootstrap from the persisted
 * provider definition), so this module needs no DB access and no provider-id
 * table: any New API connection resolves its own management client here.
 */

/**
 * @param {object} connection  provider connection (accessToken + providerSpecificData)
 * @param {object|null} proxyOptions
 * @returns {Promise<object|null>} usage payload, or null when not a New API connection
 */
export function getNewApiConnectionUsage(connection, proxyOptions = null) {
  const client = createNewApiClientForConnection(connection);
  if (!client) return null;
  return getNewApiUsage(
    client,
    connection.accessToken,
    connection.providerSpecificData || {},
    proxyOptions,
  );
}
