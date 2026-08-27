import { createNewApiClient } from "./client.js";
import { getNewApiNodeOrigin, readNewApiConnectionConfig } from "./definition.js";

/**
 * Management-client factories for New API providers (custom fork).
 *
 * Split from `definition.js` so client components can import the pure family
 * predicates without pulling the fetch/proxy stack in. Server-side callers use
 * these; the origin always comes from a persisted definition, never a request.
 */

/** Management client for a connection's deployment, or null when not New API. */
export function createNewApiClientForConnection(connection) {
  const config = readNewApiConnectionConfig(connection);
  return config ? createNewApiClient(config) : null;
}

/** Management client for a provider-node definition, or null. */
export function createNewApiClientForNode(node) {
  const origin = getNewApiNodeOrigin(node);
  return origin ? createNewApiClient({ origin, label: node.name || "New API" }) : null;
}
