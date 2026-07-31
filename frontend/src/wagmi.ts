import { http, createConfig, injected } from 'wagmi';
import { mainnet, sepolia, type Chain } from 'wagmi/chains';
import { ARC_RPC_URL } from './runtime';

// Definition for Arc Testnet
export const arcTestnet: Chain = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: [ARC_RPC_URL] },
  },
  blockExplorers: {
    default: { name: 'Arcscan', url: 'https://testnet.arcscan.app' },
  },
};

export const config = createConfig({
  chains: [mainnet, sepolia, arcTestnet],
  // Keep a real browser wallet connector available for the DApp. Without an
  // explicit connector wagmi exposes an empty list, so every "Connect wallet"
  // action silently becomes a no-op in a normal browser.
  connectors: [injected()],
  transports: {
    [mainnet.id]: http(),
    [sepolia.id]: http(),
    [arcTestnet.id]: http(ARC_RPC_URL),
  },
});
