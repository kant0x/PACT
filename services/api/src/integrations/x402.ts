import { createGatewayMiddleware, type GatewayMiddleware } from '@circle-fin/x402-batching/server';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ARC_TESTNET = 'eip155:5042002';
const ARC_MAINNET = 'eip155:5042';

export interface X402RuntimeConfig {
  sellerAddress: string;
  network: string;
  price: string;
  facilitatorUrl: string;
  route: string;
}

/**
 * Build the real x402 Gateway middleware only when an operator supplies a
 * seller wallet. There is intentionally no fallback wallet: silently charging
 * to a demo address would be an unsafe production default.
 */
export function createX402RuntimeIntegration(env = process.env): { gateway: GatewayMiddleware; config: X402RuntimeConfig } | null {
  const sellerAddress = (env.X402_SELLER_ADDRESS ?? '').trim();
  if (!sellerAddress) return null;
  if (!EVM_ADDRESS.test(sellerAddress)) throw new Error('X402_SELLER_ADDRESS must be a 20-byte 0x-prefixed address');

  const network = (env.X402_NETWORK ?? ARC_TESTNET).trim();
  const facilitatorUrl = (env.X402_FACILITATOR_URL ?? (network === ARC_MAINNET ? 'https://gateway-api.circle.com' : 'https://gateway-api-testnet.circle.com')).trim();
  const price = (env.X402_RUNTIME_PRICE ?? '$0.01').trim();
  if (!/^\$?\d+(?:\.\d{1,6})?$/.test(price)) throw new Error('X402_RUNTIME_PRICE must be a dollar amount such as $0.01');

  const config: X402RuntimeConfig = {
    sellerAddress: sellerAddress.toLowerCase(),
    network,
    price: price.startsWith('$') ? price : `$${price}`,
    facilitatorUrl,
    route: '/api/runtime/paid-capability'
  };
  const gateway = createGatewayMiddleware({
    sellerAddress: config.sellerAddress,
    networks: [config.network],
    facilitatorUrl: config.facilitatorUrl,
    description: 'PACT bounded agent capability call'
  });
  return { gateway, config };
}

