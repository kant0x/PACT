import '@fontsource/archivo-narrow/400.css';
import '@fontsource/archivo-narrow/500.css';
import '@fontsource/archivo-narrow/600.css';
import '@fontsource/archivo-narrow/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { config } from './wagmi';
import App from './App';
import { LocaleProvider } from './locale';
import './styles.css';
import './redesign.css';
import './v3.css';
import './wild.css';
import './product-signals.css';
import './protocol-examples.css';
import './protocol-page.css';
import './agents-page.css';
import './overview-page.css';
import './experience.css';

const queryClient = new QueryClient();

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
