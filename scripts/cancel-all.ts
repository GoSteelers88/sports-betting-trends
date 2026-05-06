import { cancelAllRestingOrders, getOrders } from './execute-kalshi.ts';

const before = await getOrders('resting');
console.log('Resting orders before:', before.length);
for (const o of before) {
  console.log(' -', o.ticker, o.side, o.action, 'qty:', o.remaining_count);
}
const cancelled = await cancelAllRestingOrders();
console.log('Cancelled:', cancelled);
