export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { assertServiceAuth } from "@/lib/assertServiceAuth";
import { prisma } from "@/lib/prisma";

type GradeBody = {
  pickId: number;
  result: "win" | "loss" | "push" | "void" | "pending";
  actualOutcome?: string;
  notes?: string;
};

function unitsPnl(american: number, stake: number, result: GradeBody["result"]): number | null {
  if (result === "win") {
    const decimal = american > 0 ? american / 100 : 100 / -american;
    return +(stake * decimal).toFixed(4);
  }
  if (result === "loss") return -stake;
  if (result === "push" || result === "void") return 0;
  return null; // pending
}

export async function POST(req: NextRequest) {
  const authError = assertServiceAuth(req);
  if (authError) return authError;

  let body: GradeBody;
  try {
    body = (await req.json()) as GradeBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.pickId || !body.result) {
    return NextResponse.json({ error: "pickId and result required" }, { status: 400 });
  }

  const pick = await prisma.agentPick.findUnique({ where: { id: body.pickId } });
  if (!pick) {
    return NextResponse.json({ error: `pick ${body.pickId} not found` }, { status: 404 });
  }

  const pnl = unitsPnl(pick.oddsAmerican, pick.kellyStakeUnits, body.result);

  const outcome = await prisma.agentOutcome.upsert({
    where: { pickId: pick.id },
    create: {
      pickId: pick.id,
      result: body.result,
      actualOutcome: body.actualOutcome,
      notes: body.notes,
      unitsPnl: pnl,
    },
    update: {
      result: body.result,
      actualOutcome: body.actualOutcome,
      notes: body.notes,
      unitsPnl: pnl,
      gradedAt: new Date(),
    },
  });

  return NextResponse.json({ outcome });
}
