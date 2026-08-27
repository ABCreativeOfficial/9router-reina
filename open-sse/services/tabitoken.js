import { createNewApiClient } from "./newapi/client.js";

/**
 * TabiToken deployment of the shared New API core (custom fork).
 *
 * Second consumer after GoRouter. Its management surface matched the New API
 * compatibility defaults on inspection — `{success, message, data}` envelope,
 * `Authorization: Bearer <management token>` plus `New-Api-User`, the same
 * account/token/model/status routes, and `quota_per_unit`-based quota — so this
 * adapter only supplies the trusted origin and label.
 *
 * The origin is server-side configuration; no browser-supplied value reaches it.
 */

export const TABITOKEN_ORIGIN = "https://tabitoken.com";

const client = createNewApiClient({
  origin: TABITOKEN_ORIGIN,
  label: "TabiToken",
});

export const TABITOKEN_ENDPOINTS = client.endpoints;

/** The shared client, for the usage adapter and onboarding binding. */
export const tabitokenClient = client;

export function getTabiTokenAccount(accessToken, userId, proxyOptions = null) {
  return client.getAccount(accessToken, userId, proxyOptions);
}

export function listTabiTokenTokens(accessToken, userId, proxyOptions = null) {
  return client.listTokens(accessToken, userId, proxyOptions);
}

export function retrieveTabiTokenTokenKey(accessToken, userId, tokenId, proxyOptions = null) {
  return client.retrieveTokenKey(accessToken, userId, tokenId, proxyOptions);
}

export function validateTabiTokenInferenceKey(apiKey, proxyOptions = null) {
  return client.validateInferenceKey(apiKey, proxyOptions);
}

export function fetchTabiTokenModels(accessToken, userId, proxyOptions = null) {
  return client.fetchModels(accessToken, userId, proxyOptions);
}

export function fetchTabiTokenStatus(proxyOptions = null) {
  return client.fetchStatus(proxyOptions);
}
