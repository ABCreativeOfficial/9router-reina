import { getProviderConnectionById } from "@/models";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { resolveNewApiProviderClient } from "@/sse/services/newapiProvider";
import { getNewApiNodeOrigin, isNewApiConnection } from "open-sse/services/newapi/definition.js";

const transfersInFlight = new Set();

function normalizeReferral(self) {
  if (!self?.referralSupported) return { supported: false };
  const pendingQuota = self.affQuota;
  const totalEarnedQuota = self.affHistoryQuota;
  const invites = self.affCount;
  if (![pendingQuota, totalEarnedQuota, invites].every(Number.isFinite)) return { supported: false };
  return {
    supported: true,
    pendingQuota,
    totalEarnedQuota,
    invites,
    affCode: self.affCode || "",
  };
}

async function resolveConnection(connectionId) {
  const connection = await getProviderConnectionById(String(connectionId || ""));
  if (!connection || !isNewApiConnection(connection)) return null;

  const resolved = await resolveNewApiProviderClient(connection.provider);
  if (!resolved || resolved.node.id !== connection.provider) return null;
  const providerOrigin = getNewApiNodeOrigin(resolved.node);
  if (!providerOrigin || providerOrigin !== connection.providerSpecificData?.newApiOrigin) return null;

  const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData);
  return {
    connection,
    client: resolved.client,
    providerOrigin,
    proxyOptions: {
      connectionProxyEnabled: proxy.connectionProxyEnabled === true,
      connectionProxyUrl: proxy.connectionProxyUrl || "",
      connectionNoProxy: proxy.connectionNoProxy || "",
      vercelRelayUrl: proxy.vercelRelayUrl || "",
      strictProxy: false,
    },
  };
}

async function readReferral(resolved) {
  const result = await resolved.client.getSelf(
    resolved.connection.accessToken,
    resolved.connection.providerSpecificData?.userId,
    resolved.proxyOptions,
  );
  return result.ok ? { ok: true, referral: normalizeReferral(result.self) } : result;
}

export async function getNewApiReferralStatus(connectionId) {
  const resolved = await resolveConnection(connectionId);
  if (!resolved) return { ok: false, status: 404, message: "New API connection not found." };
  const result = await readReferral(resolved);
  return result.ok ? { ...result, resolved } : result;
}

export async function transferAllNewApiReferral(connectionId) {
  const id = String(connectionId || "");
  if (transfersInFlight.has(id)) {
    return { ok: false, status: 409, code: "transfer_in_progress", message: "Referral transfer already in progress." };
  }
  transfersInFlight.add(id);

  try {
    const resolved = await resolveConnection(id);
    if (!resolved) return { ok: false, status: 404, message: "New API connection not found." };

    const before = await readReferral(resolved);
    if (!before.ok) return before;
    if (!before.referral.supported) {
      return {
        ok: true,
        transferred: false,
        reason: "unsupported",
        referral: before.referral,
        resolved,
      };
    }

    const amount = before.referral.pendingQuota;
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return {
        ok: true,
        transferred: false,
        reason: "nothing_to_transfer",
        referral: before.referral,
        resolved,
      };
    }

    const transfer = await resolved.client.transferAffiliateQuota(
      resolved.connection.accessToken,
      resolved.connection.providerSpecificData?.userId,
      amount,
      resolved.proxyOptions,
    );
    if (!transfer.ok) {
      const refreshed = await readReferral(resolved).catch(() => null);
      return {
        ...transfer,
        ...(refreshed?.ok ? { referral: refreshed.referral } : {}),
      };
    }

    const after = await readReferral(resolved);
    if (!after.ok) return after;
    return {
      ok: true,
      transferred: true,
      transferredQuota: amount,
      referral: after.referral,
      resolved,
    };
  } finally {
    transfersInFlight.delete(id);
  }
}

export function __resetReferralTransfersForTest() {
  transfersInFlight.clear();
}
