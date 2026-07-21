import { http, createConfig, injected } from 'wagmi';
import { mainnet, sepolia, type Chain } from 'wagmi/chains';

// Definition for Arc Testnet
export const arcTestnet: Chain = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://testnet.arc.network'] },
  },
  blockExplorers: {
    default: { name: 'Arc Explorer', url: 'https://explorer.testnet.arc.network' },
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
    [arcTestnet.id]: http(),
  },
});
