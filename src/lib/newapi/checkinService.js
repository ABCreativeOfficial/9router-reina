import { getProviderConnectionById } from "@/models";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { resolveNewApiProviderClient } from "@/sse/services/newapiProvider";
import { getNewApiNodeOrigin, isNewApiConnection } from "open-sse/services/newapi/definition.js";

export async function resolveNewApiCheckinConnection(connectionId) {
  const connection = await getProviderConnectionById(String(connectionId || ""));
  if (!connection || !isNewApiConnection(connection)) return null;

  const resolved = await resolveNewApiProviderClient(connection.provider);
  if (!resolved || resolved.node.id !== connection.provider) return null;
  const providerOrigin = getNewApiNodeOrigin(resolved.node);
  if (!providerOrigin || providerOrigin !== connection.providerSpecificData?.newApiOrigin) return null;

  const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
  return {
    connection,
    client: resolved.client,
    node: resolved.node,
    providerOrigin,
    proxyOptions: {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    },
  };
}

export async function fetchNewApiCheckinStatus(resolved) {
  return resolved.client.getCheckinStatus(
    resolved.connection.accessToken,
    resolved.connection.providerSpecificData?.userId,
    resolved.proxyOptions,
  );
}

export async function performNewApiCheckin(resolved) {
  return resolved.client.performCheckin(
    resolved.connection.accessToken,
    resolved.connection.providerSpecificData?.userId,
    resolved.proxyOptions,
  );
}
