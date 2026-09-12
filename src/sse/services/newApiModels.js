import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { createNewApiClientForConnection } from "open-sse/services/newapi/resolve.js";

/**
 * Resolve one New API account's live catalog through its stored management
 * credential and trusted deployment origin. Returns null for other families.
 */
export async function resolveNewApiConnectionModels(connection) {
  const client = createNewApiClientForConnection(connection);
  if (!client) return null;

  const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
  return client.fetchModels(
    connection.accessToken,
    connection.providerSpecificData?.userId,
    {
      connectionProxyEnabled: proxy.connectionProxyEnabled === true,
      connectionProxyUrl: proxy.connectionProxyUrl || "",
      connectionNoProxy: proxy.connectionNoProxy || "",
      vercelRelayUrl: proxy.vercelRelayUrl || "",
      strictProxy: proxy.strictProxy === true,
    },
  );
}
