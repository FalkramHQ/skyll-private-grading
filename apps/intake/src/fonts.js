// Background font loading for the Skyll Notebook type (Bricolage Grotesque for
// headings, Instrument Sans for body).
//
// OTA safety: the fonts are bundled JS assets loaded at runtime through
// expo-font, whose native module ships inside `expo`. Loading must never block
// or crash the app:
//   * nothing waits on the fonts; screens render immediately with the system
//     font and pick up the brand fonts on the next render once they load;
//   * the wait is bounded by a short timeout;
//   * any failure (missing native module, asset download error, bad file)
//     resolves to `false` and the system font stays in place.

import { useEffect, useState } from 'react';
import { fontFamily } from './theme';

export const FONT_LOAD_TIMEOUT_MS = 1500;

function fontSources() {
  return {
    [fontFamily.display]: require('@expo-google-fonts/bricolage-grotesque/800ExtraBold/BricolageGrotesque_800ExtraBold.ttf'),
    [fontFamily.regular]: require('@expo-google-fonts/instrument-sans/400Regular/InstrumentSans_400Regular.ttf'),
    [fontFamily.semibold]: require('@expo-google-fonts/instrument-sans/600SemiBold/InstrumentSans_600SemiBold.ttf'),
    [fontFamily.bold]: require('@expo-google-fonts/instrument-sans/700Bold/InstrumentSans_700Bold.ttf'),
  };
}

let loadPromise = null;

// Starts (once) the real font load. Never rejects.
function startFontLoad(loader) {
  if (!loadPromise) {
    loadPromise = new Promise((resolve) => {
      try {
        // Required lazily so a missing native module throws here, inside the
        // try, instead of at import time.
        const Font = loader ? loader() : require('expo-font');
        Promise.resolve(Font.loadAsync(fontSources())).then(() => resolve(true), () => resolve(false));
      } catch {
        resolve(false);
      }
    });
  }
  return loadPromise;
}

// Resolves true when the fonts loaded within `timeoutMs`, false otherwise.
// `onLateLoad` fires if the load finishes successfully after the timeout.
export function loadAppFonts({ timeoutMs = FONT_LOAD_TIMEOUT_MS, onLateLoad, loader } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(false);
    }, timeoutMs);
    startFontLoad(loader).then((ok) => {
      if (settled) {
        if (ok && onLateLoad) onLateLoad();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    });
  });
}

// Test hook: forget the cached load so each test starts clean.
export function resetFontLoadForTests() {
  loadPromise = null;
}

// Re-renders the caller once the brand fonts are available. Never gates
// rendering: the first paint uses the system font.
export function useAppFonts() {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    const markLoaded = () => { if (active) setLoaded(true); };
    loadAppFonts({ onLateLoad: markLoaded }).then((ok) => { if (ok) markLoaded(); });
    return () => { active = false; };
  }, []);
  return loaded;
}
