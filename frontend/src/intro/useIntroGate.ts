import { useCallback, useEffect, useState } from 'react';

/**
 * One-time intro gate.
 *
 * First visit (no flag in localStorage) → the WebGL intro is shown. When the
 * visitor finishes or skips it, we persist the flag and never show it again.
 * Returning visitors go straight to the app.
 *
 * SSR-safe: defaults to "seen" until we can read localStorage on the client,
 * so nothing flashes during hydration.
 */

const STORAGE_KEY = 'pact:intro-seen';

function readSeen(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // Private mode / storage disabled — treat as seen so we never trap the user.
    return true;
  }
}

export interface IntroGate {
  /** True while the intro should be rendered. */
  showIntro: boolean;
  /** Call when the intro is finished or skipped. Persists the flag. */
  dismiss: () => void;
  /** True once we've resolved localStorage on the client (avoids flash). */
  ready: boolean;
}

export function useIntroGate(): IntroGate {
  const [ready, setReady] = useState(false);
  const [showIntro, setShowIntro] = useState(false);

  useEffect(() => {
    setShowIntro(!readSeen());
    setReady(true);
  }, []);

  const dismiss = useCallback(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* ignore storage failures */
    }
    setShowIntro(false);
  }, []);

  return { showIntro, dismiss, ready };
}
