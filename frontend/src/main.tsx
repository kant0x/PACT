import '@fontsource/archivo-narrow/400.css';
import '@fontsource/archivo-narrow/500.css';
import '@fontsource/archivo-narrow/600.css';
import '@fontsource/archivo-narrow/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { config } from './wagmi';
import App from './App';
import { LocaleProvider } from './locale';
import './design/tokens.css';
import './design/base.css';
import './design/reboot.css';

const queryClient = new QueryClient();
const pactBuildId = 'network-reboot-2026-07-28-01';

if (typeof window !== 'undefined') {
  window.dispatchEvent(new CustomEvent('pact:build-ready', { detail: pactBuildId }));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <LocaleProvider>
          <App />
        </LocaleProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
