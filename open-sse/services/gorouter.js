import { createNewApiClient } from "./newapi/client.js";

/**
 * GoRouter deployment of the shared New API core (custom fork).
 *
 * Everything reusable lives in `newapi/client.js`; this file is the GoRouter
 * adapter — its trusted origin, its label, and the named exports the existing
 * GoRouter routes/services/tests already import. External behavior is unchanged.
 */

export const GOROUTER_ORIGIN = "https://gorouter.app";

const client = createNewApiClient({
  origin: GOROUTER_ORIGIN,
  label: "GoRouter",
});

export const GOROUTER_ENDPOINTS = client.endpoints;

export { normalizeNewApiUserId as normalizeGoRouterUserId, isMaskedNewApiKey as isMaskedGoRouterKey } from "./newapi/client.js";

/** The shared client, for modules that also need usage/status primitives. */
export const gorouterClient = client;

export function getGoRouterAccount(accessToken, userId, proxyOptions = null) {
  return client.getAccount(accessToken, userId, proxyOptions);
}

export function validateGoRouterManagementCredentials(accessToken, userId, proxyOptions = null) {
  return client.getAccount(accessToken, userId, proxyOptions);
}

export function listGoRouterTokens(accessToken, userId, proxyOptions = null) {
  return client.listTokens(accessToken, userId, proxyOptions);
}

export function retrieveGoRouterTokenKey(accessToken, userId, tokenId, proxyOptions = null) {
  return client.retrieveTokenKey(accessToken, userId, tokenId, proxyOptions);
}

export function validateGoRouterInferenceKey(apiKey, proxyOptions = null) {
  return client.validateInferenceKey(apiKey, proxyOptions);
}

export function fetchGoRouterModels(accessToken, userId, proxyOptions = null) {
  return client.fetchModels(accessToken, userId, proxyOptions);
}

export function fetchGoRouterStatus(proxyOptions = null) {
  return client.fetchStatus(proxyOptions);
}
