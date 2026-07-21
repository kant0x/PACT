import { createArcGatewayClient } from '../src/integrations/circle.js';

const [command = 'balances', value] = process.argv.slice(2);
const client = createArcGatewayClient();

if (command === 'balances') {
  console.log(JSON.stringify(await client.getBalances(), (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2));
} else if (command === 'deposit') {
  if (!value) throw new Error('Usage: npm run circle:gateway -- deposit <USDC>');
  console.log(JSON.stringify(await client.deposit(value), (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2));
} else if (command === 'pay') {
  const url = value ?? process.env.NANOPAYMENT_URL;
  if (!url) throw new Error('Usage: npm run circle:gateway -- pay <x402 URL>');
  const supported = await client.supports(url);
  if (!supported.supported) throw new Error(`Endpoint does not support Gateway batching: ${supported.error ?? 'unknown reason'}`);
  console.log(JSON.stringify(await client.pay(url), (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2));
} else {
  throw new Error(`Unknown command ${command}. Use balances, deposit, or pay.`);
}
