import {
  getNewApiReferralStatus,
  transferAllNewApiReferral,
} from "@/lib/newapi/referralService";
import { convertNewApiQuota } from "open-sse/services/newapi/usage.js";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

function displayQuota(raw, deploymentStatus) {
  const converted = convertNewApiQuota(raw, deploymentStatus);
  return converted ? { raw, ...converted } : raw == null ? null : { raw, value: null, unit: null };
}

function safeReferral(referral, deploymentStatus) {
  if (!referral?.supported) return { supported: false };
  return {
    supported: true,
    pendingQuota: referral.pendingQuota,
    totalEarnedQuota: referral.totalEarnedQuota,
    invites: referral.invites,
    affCode: referral.affCode,
    pending: displayQuota(referral.pendingQuota, deploymentStatus),
    totalEarned: displayQuota(referral.totalEarnedQuota, deploymentStatus),
    canTransfer: referral.pendingQuota > 0,
  };
}

async function deploymentStatus(result) {
  return result?.resolved?.client?.fetchStatus(result.resolved.proxyOptions) || null;
}

export async function GET(_request, { params }) {
  try {
    const { connectionId } = await params;
    const result = await getNewApiReferralStatus(connectionId);
    if (!result.ok) return json({ error: result.message }, result.status || 502);
    const status = result.referral.supported ? await deploymentStatus(result) : null;
    return json({ success: true, data: safeReferral(result.referral, status) });
  } catch {
    return json({ error: "Unable to read referral rewards." }, 500);
  }
}

export async function POST(request, { params }) {
  try {
    const text = await request.text();
    if (text.trim()) {
      const body = JSON.parse(text);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0) {
        return json({ error: "Referral transfer accepts no amount or target fields." }, 400);
      }
    }

    const { connectionId } = await params;
    const result = await transferAllNewApiReferral(connectionId);
    if (!result.ok) {
      return json(
        { error: result.message, ...(result.code ? { code: result.code } : {}) },
        result.status || 502,
      );
    }
    const status = result.referral?.supported ? await deploymentStatus(result) : null;
    return json({
      success: true,
      data: {
        transferred: result.transferred === true,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.transferredQuota != null ? {
          transferredQuota: result.transferredQuota,
          transferredAmount: displayQuota(result.transferredQuota, status),
        } : {}),
        referral: safeReferral(result.referral, status),
      },
    });
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: "Invalid request body." }, 400);
    return json({ error: "Unable to transfer referral rewards." }, 500);
  }
}
