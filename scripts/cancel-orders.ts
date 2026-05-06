#!/usr/bin/env tsx
import { cancelAllRestingOrders, getOrders, getPositions } from "./execute-kalshi.js";

void (async () => {
  const [orders, positions] = await Promise.all([getOrders("resting"), getPositions()]);

  console.log("\n=== RESTING ORDERS ===");
  if (orders.length === 0) {
    console.log("None");
  } else {
    for (const o of orders) {
      console.log(` - ${o.ticker} | ${o.side} ${o.action} | qty=${o.remaining_count} | price=${o.yes_price ?? o.no_price}`);
    }
  }

  console.log("\n=== POSITIONS ===");
  const held = positions.filter(p => p.position !== 0);
  if (held.length === 0) {
    console.log("None");
  } else {
    for (const p of held) {
      console.log(` - ${p.ticker} | qty=${p.position} | exposure=${p.market_exposure}`);
    }
  }

  console.log(`\nCanceling ${orders.length} resting orders...`);
  const cancelled = await cancelAllRestingOrders();
  console.log(`Done — cancelled ${cancelled} orders.`);
})();
