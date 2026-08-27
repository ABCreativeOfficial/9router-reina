import { getSettings } from "@/lib/localDb";

/**
 * Resolve this 9Router's own public origin (custom fork).
 *
 * 9Router is not necessarily on localhost: it may be served over HTTPS behind a
 * reverse proxy or a tunnel. The pairing handshake therefore has to *tell* the
 * bridge which router origin to complete against instead of assuming a default,
 * and completion has to be checked against the origin the pairing was minted for.
 *
 * Resolution order mirrors the existing SAML/OIDC base-URL contract:
 * settings.baseUrl → BASE_URL → NEXT_PUBLIC_BASE_URL → forwarded proto/host →
 * the request URL's own origin.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function trimSlashes(value) {
  return String(value || "").replace(/\/+$/, "");
}

function safeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

/**
 * Origin the request itself arrived on, honouring a trusted reverse proxy.
 *
 * Both headers are client-settable on a direct connection, so this is not a trust
 * boundary — see `isAcceptableCompletionOrigin`.
 */
export function readRequestOrigin(request) {
  const forwardedProto = request?.headers?.get?.("x-forwarded-proto") || "";
  const forwardedHost = request?.headers?.get?.("x-forwarded-host") || "";
  const host = forwardedHost || request?.headers?.get?.("host") || "";
  if (host) {
    const protocol = (forwardedProto.split(",")[0].trim()
      || (request?.url ? new URL(request.url).protocol : "http:")).replace(/:$/, "");
    return safeOrigin(`${protocol}://${host}`);
  }
  return request?.url ? safeOrigin(request.url) : "";
}

/** Is this origin on the loopback interface? */
export function isLoopbackOrigin(origin) {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * The origin the bridge should post its completion to.
 * @param {Request} request
 * @returns {Promise<string>} a canonical origin, or "" when it cannot be resolved
 */
export async function resolveRouterOrigin(request) {
  let configured = "";
  try {
    const settings = await getSettings();
    configured = trimSlashes(settings?.baseUrl || "");
  } catch {
    // Settings are unavailable early in boot; fall through to env/headers.
  }
  configured = configured
    || trimSlashes(process.env.BASE_URL || "")
    || trimSlashes(process.env.NEXT_PUBLIC_BASE_URL || "");

  return (configured && safeOrigin(configured)) || readRequestOrigin(request);
}

/**
 * May a completion arriving at `arrivalOrigin` settle a pairing minted for
 * `pairedOrigin`?
 *
 * Equal origins match. A **host** match is also accepted, because the arrival
 * scheme comes from `x-forwarded-proto`: a reverse proxy that forwards `Host` but
 * not that header makes an https deployment read as `http://…`, which would 403
 * every completion. A loopback arrival is accepted too — that is the case where
 * the dashboard is used over a tunnel while the bridge posts to the local port.
 *
 * This is a misconfiguration sanity check, not a trust boundary: both the host
 * and the scheme are header-derived and a non-browser client can set them. The
 * actual boundary is the one-time pairing secret plus the in-process session map,
 * which already proves the completion reached the process that minted it.
 */
export function isAcceptableCompletionOrigin(pairedOrigin, arrivalOrigin) {
  if (!pairedOrigin) return true;
  if (pairedOrigin === arrivalOrigin) return true;
  const pairedHost = readHost(pairedOrigin);
  if (pairedHost && pairedHost === readHost(arrivalOrigin)) return true;
  return isLoopbackOrigin(arrivalOrigin);
}

function readHost(value) {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return "";
  }
}
