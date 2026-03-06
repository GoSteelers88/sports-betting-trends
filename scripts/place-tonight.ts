import { createOrder } from "./execute-kalshi.js";
import crypto from "node:crypto";

async function main() {
  const bets = [
    { ticker: "KXNBAGAME-26MAR04CHABOS-CHA", priceCents: 32, budgetUsd: 3.33 },
    { ticker: "KXNBAGAME-26MAR04UTAPHI-PHI",  priceCents: 80, budgetUsd: 3.33 },
    { ticker: "KXNBAGAME-26MAR04ATLMIL-ATL",  priceCents: 48, budgetUsd: 3.34 },
  ];

  for (const bet of bets) {
    const countInt = Math.max(1, Math.floor(bet.budgetUsd / (bet.priceCents / 100)));
    const priceDollars = (bet.priceCents / 100).toFixed(4);
    try {
      const order = await createOrder({
        ticker: bet.ticker,
        side: "yes",
        action: "buy",
        type: "limit",
        yes_price_dollars: priceDollars,
        count_fp: countInt.toFixed(2),
        client_order_id: crypto.randomUUID(),
      });
      const cost = (countInt * bet.priceCents / 100).toFixed(2);
      console.log(`✅ ${bet.ticker} YES @ $${priceDollars} × ${countInt} = $${cost} | ${order.order_id}`);
    } catch (err) {
      console.error(`❌ ${bet.ticker}: ${(err as Error).message}`);
    }
  }
}

main().catch(console.error);
