import {
  getProviderDisplayInitials,
  getProviderDisplayName,
} from "./newApiDisplay.js";
import { AI_PROVIDERS } from "../constants/providers.js";

/**
 * Collapse provider connections into provider-level topology entities.
 *
 * A topology node represents a provider, never an account. The generated
 * provider id remains the grouping key; persisted node/connection metadata is
 * display-only. That keeps active/error/request aggregation aligned with the
 * router while preventing connection names from becoming graph labels.
 *
 * A connection whose provider cannot be resolved is skipped: the graph is built
 * from live connections, and a leftover row must not invent a provider node that
 * the router cannot route to. Resolvable means one of:
 *   - a static registry provider (AI_PROVIDERS),
 *   - a compatible provider that owns a providerNodes definition,
 *   - a dynamic (New API) provider carrying its own persisted markers.
 * That last case is why markers count: a New API connection is identified by
 * `newApiOrigin`/`prefix`, not by a static entry.
 *
 * @param {object[]} connections - provider connections
 * @param {object[]} providerNodes - provider node definitions
 * @param {object} [options]
 * @param {(providerId: string) => boolean} [options.isKnownProvider] - extra
 *   resolver for providers known outside the registry (defaults to the static
 *   registry, which is what the router can always route to)
 */
export function buildProviderTopologyProviders(connections = [], providerNodes = [], options = {}) {
  const nodeById = new Map(providerNodes.map((node) => [node.id, node]));
  const extraResolver = typeof options.isKnownProvider === "function"
    ? options.isKnownProvider
    : null;
  const isKnownProvider = (providerId) => Boolean(AI_PROVIDERS[providerId])
    || Boolean(extraResolver?.(providerId));
  const providers = new Map();

  for (const connection of connections) {
    if (!connection?.provider || connection.isActive === false) continue;

    const node = nodeById.get(connection.provider);
    const hasOwnMarkers = Boolean(
      connection.providerSpecificData?.newApiOrigin
      || connection.providerSpecificData?.prefix,
    );
    if (!node && !hasOwnMarkers && !isKnownProvider(connection.provider)) continue;

    const existing = providers.get(connection.provider);
    if (existing) {
      existing.connectionCount += 1;
      continue;
    }

    const isNewApi = node?.family === "new-api"
      || Boolean(connection.providerSpecificData?.newApiOrigin);
    const label = node?.name?.trim()
      || getProviderDisplayName(connection);
    const textIcon = isNewApi
      ? getProviderDisplayInitials({
        ...connection,
        providerSpecificData: {
          ...(connection.providerSpecificData || {}),
          prefix: node?.prefix || connection.providerSpecificData?.prefix,
          newApiLabel: node?.name || connection.providerSpecificData?.newApiLabel,
          newApiOrigin: node?.newApi?.origin || connection.providerSpecificData?.newApiOrigin,
        },
      })
      : null;

    providers.set(connection.provider, {
      provider: connection.provider,
      label,
      textIcon,
      isNewApi,
      connectionCount: 1,
    });
  }

  return [...providers.values()];
}
