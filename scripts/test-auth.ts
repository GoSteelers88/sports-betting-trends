import { getBalance, getPositions, getOrders } from "./execute-kalshi.ts";

async function main() {
  const [balance, positions, orders] = await Promise.all([
    getBalance(),
    getPositions(),
    getOrders(),
  ]);
  console.log("balance:", JSON.stringify(balance));
  console.log("positions:", JSON.stringify(positions));
  console.log("resting orders:", JSON.stringify(orders));
}

main().catch((e) => console.error("FAIL:", e.message, e.status));
