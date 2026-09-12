import { getModelsByProviderId } from "@/shared/constants/models";
import { getProviderAlias } from "@/shared/constants/providers";
import { isNewApiConnection } from "open-sse/services/newapi/definition.js";

export function isRuntimeModelProvider(connection) {
  return isNewApiConnection(connection);
}

export function groupActiveProviderConnections(connections) {
  const groups = new Map();
  for (const connection of connections || []) {
    if (!connection?.provider || connection.isActive === false) continue;
    const list = groups.get(connection.provider);
    if (list) list.push(connection);
    else groups.set(connection.provider, [connection]);
  }
  return groups;
}

export function mergeRuntimeProviderModels(modelLists) {
  return Array.from(new Map(
    (modelLists || [])
      .flat()
      .filter((model) => model?.id)
      .map((model) => [model.id, model])
  ).values());
}

export function buildRuntimeProviderCatalog({ connections = [], runtimeModels = {} } = {}) {
  const catalog = {};
  for (const [providerId, providerConnections] of groupActiveProviderConnections(connections)) {
    const connection = providerConnections[0];
    const liveModels = runtimeModels[providerId] || [];
    const staticModels = getModelsByProviderId(providerId);
    const isRuntime = isRuntimeModelProvider(connection);
    const staticAlias = getProviderAlias(providerId) || providerId;
    const alias = isRuntime || staticModels.length === 0
      ? connection.providerSpecificData?.prefix || staticAlias
      : staticAlias;
    const fallbackModels = providerConnections.flatMap((candidate) => [
      ...(candidate.defaultModel ? [{ id: candidate.defaultModel, name: candidate.defaultModel }] : []),
      ...(candidate.providerSpecificData?.customModels || []),
    ]);
    if (!isRuntime && staticModels.length === 0 && fallbackModels.length === 0
      && providerConnections.some((candidate) => candidate.testStatus === "active")) {
      fallbackModels.push({ id: "model-id", name: `${alias}/model-id` });
    }
    const models = isRuntime
      ? liveModels
      : staticModels.length > 0 ? staticModels : fallbackModels;

    catalog[providerId] = {
      providerId,
      alias,
      name: connection.providerSpecificData?.newApiLabel || connection.name || providerId,
      isRuntime,
      models: mergeRuntimeProviderModels([models]),
    };
  }
  return catalog;
}

export async function fetchRuntimeProviderModels(connections, fetchFn = fetch) {
  const providerIds = Array.from(groupActiveProviderConnections(connections))
    .filter(([, providerConnections]) => isRuntimeModelProvider(providerConnections[0]))
    .map(([providerId]) => providerId);
  if (providerIds.length === 0) return {};

  try {
    const query = providerIds.map((providerId) => `provider=${encodeURIComponent(providerId)}`).join("&");
    const response = await fetchFn(`/api/models/runtime?${query}`, { cache: "no-store" });
    if (!response.ok) return {};
    const data = await response.json();
    return data.providers && typeof data.providers === "object" ? data.providers : {};
  } catch {
    return {};
  }
}

export function catalogModelsForCli(catalog) {
  return Object.values(catalog || {}).flatMap((provider) =>
    provider.models.map((model) => ({
      value: `${provider.alias}/${model.id}`,
      label: `${provider.alias}/${model.id}`,
      provider: provider.providerId,
      alias: provider.alias,
      connectionName: provider.name,
      modelId: model.id,
    }))
  );
}
