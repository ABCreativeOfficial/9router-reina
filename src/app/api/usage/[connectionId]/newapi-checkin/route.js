import { resolveRouterOrigin } from "@/lib/newapi/routerOrigin";
import {
  buildCheckinLaunchUrl,
  CHECKIN_PROTOCOL,
  createCheckinSession,
} from "@/lib/newapi/checkin";
import {
  fetchNewApiCheckinStatus,
  performNewApiCheckin,
  resolveNewApiCheckinConnection,
} from "@/lib/newapi/checkinService";
import { convertNewApiQuota } from "open-sse/services/newapi/usage.js";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

function formatQuota(raw, status) {
  const converted = convertNewApiQuota(raw, status);
  return converted ? { raw, ...converted } : raw == null ? null : { raw, value: raw, unit: "quota units" };
}

function safeStatus(checkin, deploymentStatus) {
  return {
    supported: checkin.supported === true,
    ...(checkin.supported === true ? {
      enabled: checkin.enabled === true,
      checkedInToday: checkin.checkedInToday === true,
      minReward: formatQuota(checkin.minQuota, deploymentStatus),
      maxReward: formatQuota(checkin.maxQuota, deploymentStatus),
      checkinCount: checkin.checkinCount,
      totalCheckins: checkin.totalCheckins,
      totalReward: formatQuota(checkin.totalQuota, deploymentStatus),
      records: (checkin.records || []).map((record) => ({
        checkinDate: record.checkinDate,
        reward: formatQuota(record.quotaAwarded, deploymentStatus),
      })),
    } : {}),
  };
}

async function resolve(params) {
  const { connectionId } = await params;
  return resolveNewApiCheckinConnection(connectionId);
}

export async function GET(_request, { params }) {
  try {
    const resolved = await resolve(params);
    if (!resolved) return json({ error: "New API connection not found." }, 404);

    const [result, deploymentStatus] = await Promise.all([
      fetchNewApiCheckinStatus(resolved),
      resolved.client.fetchStatus(resolved.proxyOptions),
    ]);
    if (!result.ok) return json({ error: result.message }, result.status || 502);
    return json({ success: true, data: safeStatus(result.checkin, deploymentStatus) });
  } catch {
    return json({ error: "Unable to read check-in status." }, 500);
  }
}

export async function POST(request, { params }) {
  try {
    const resolved = await resolve(params);
    if (!resolved) return json({ error: "New API connection not found." }, 404);

    const result = await performNewApiCheckin(resolved);
    if (!result.ok) return json({ error: result.message }, result.status || 502);
    if (result.status !== "verification_required") {
      const deploymentStatus = result.quotaAwarded == null
        ? null
        : await resolved.client.fetchStatus(resolved.proxyOptions);
      return json({
        success: true,
        data: {
          ...result,
          quotaAwarded: formatQuota(result.quotaAwarded, deploymentStatus),
        },
      });
    }

    const session = createCheckinSession({
      connectionId: resolved.connection.id,
      providerId: resolved.node.id,
      providerOrigin: resolved.providerOrigin,
      providerLabel: resolved.node.name,
      routerOrigin: await resolveRouterOrigin(request),
      userId: String(resolved.connection.providerSpecificData?.userId || ""),
    });
    return json({
      success: true,
      data: {
        status: "verification_required",
        verification: {
          protocol: CHECKIN_PROTOCOL,
          checkinId: session.checkinId,
          checkinSecret: session.checkinSecret,
          expiresAt: session.expiresAt,
          providerOrigin: session.providerOrigin,
          providerLabel: session.providerLabel,
          routerOrigin: session.routerOrigin,
          launchUrl: buildCheckinLaunchUrl(session),
        },
      },
    });
  } catch {
    return json({ error: "Unable to perform check-in." }, 500);
  }
}
