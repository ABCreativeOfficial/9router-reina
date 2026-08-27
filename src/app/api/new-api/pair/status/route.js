import { NextResponse } from "next/server";
import { readPairingStatus } from "@/lib/newapi/pairing";

export const dynamic = "force-dynamic";

/**
 * GET /api/new-api/pair/status?id=<pairingId>
 *
 * Non-secret pairing state for the modal's poll loop. Never returns the pairing
 * secret, the management token, the inference key, or any upstream response.
 * An unknown or lapsed pairing reads as `expired`, so the UI cannot hang.
 */
export async function GET(request) {
  try {
    const pairingId = new URL(request.url).searchParams.get("id");
    return NextResponse.json(
      { success: true, data: readPairingStatus(pairingId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Unable to read pairing status." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
