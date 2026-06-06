import { NextResponse } from "next/server";
import { getDevigLedgerView } from "@/lib/devig-paper";

export const dynamic = "force-dynamic";

// Read-only view of the de-vig +EV paper book (JSON-backed, no DB).
export async function GET() {
  try {
    return NextResponse.json(getDevigLedgerView());
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message ?? "unavailable" },
      { status: 503 },
    );
  }
}
