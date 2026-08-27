import {
  getProviderDisplayInitials,
  getProviderDisplayName,
} from "./newApiDisplay.js";

/**
 * Collapse provider connections into provider-level topology entities.
 *
 * A topology node represents a provider, never an account. The generated
 * provider id remains the grouping key; persisted node/connection metadata is
 * display-only. That keeps active/error/request aggregation aligned with the
 * router while preventing connection names from becoming graph labels.
 */
export function buildProviderTopologyProviders(connections = [], providerNodes = []) {
  const nodeById = new Map(providerNodes.map((node) => [node.id, node]));
  const providers = new Map();

  for (const connection of connections) {
    if (!connection?.provider || connection.isActive === false) continue;

    const existing = providers.get(connection.provider);
    if (existing) {
      existing.connectionCount += 1;
      continue;
    }

    const node = nodeById.get(connection.provider);
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
