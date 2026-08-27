import { NextResponse } from "next/server";
import {
  buildPairingLoginUrl,
  createPairingSession,
  normalizePairUserId,
} from "@/lib/gorouter/pairing";

export const dynamic = "force-dynamic";

/**
 * POST /api/providers/gorouter/pair/start
 *
 * Opens a short-lived, single-use pairing the Chrome bridge can complete.
 * `expectedUserId` is set for reconnect so a different GoRouter account cannot
 * silently take over an existing connection. The secret travels only in the
 * returned URL's fragment, which browsers never send to GoRouter's server.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const expectedUserId = normalizePairUserId(body?.expectedUserId) || null;
    if (body?.expectedUserId != null && body.expectedUserId !== "" && !expectedUserId) {
      return NextResponse.json(
        { error: "Invalid GoRouter account id." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const session = createPairingSession({ expectedUserId });
    return NextResponse.json(
      {
        success: true,
        data: {
          pairingId: session.pairingId,
          pairSecret: session.pairSecret,
          expiresAt: session.expiresAt,
          loginUrl: buildPairingLoginUrl(session),
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Unable to start GoRouter pairing." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
