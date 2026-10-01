import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/roboto-mono/400.css';
import './ui/styles/base.css';
import './ui/styles/controls.css';
import './ui/styles/layout.css';
import './ui/styles/panels.css';
import './ui/styles/preview.css';
import './ui/styles/inspector.css';
import './ui/styles/timeline.css';
import './ui/styles/dialogs.css';
import { App } from './ui/App';
import { Unsupported, missingFeatures } from './ui/Unsupported';
import { bootstrap } from './state/projectManager';
import { registerServiceWorker } from './pwa';

const root = createRoot(document.getElementById('root')!);
const missing = missingFeatures();

if (missing.length > 0) {
  root.render(<Unsupported missing={missing} />);
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  void bootstrap();
  registerServiceWorker();
}

// Expose a tiny debugging/testing hook (no user data leaves the page).
if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) {
  void Promise.all([import('./state/store'), import('./playback/player'), import('./media/registry'), import('./state/projectManager')]).then(([store, pl, reg, pm]) => {
    (window as unknown as Record<string, unknown>).__cutline = {
      editor: store.useEditor,
      playback: store.usePlayback,
      player: pl.player,
      media: reg.media,
      storage: { collectGarbage: pm.collectGarbage },
    };
  });
}
