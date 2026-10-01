import { toast } from './state/store';

/**
 * Register the offline service worker (production only). When a new version
 * is waiting, offer a reload instead of swapping code under a running editor.
 */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const offer = (worker: ServiceWorker) =>
        toast({
          kind: 'info',
          message: 'A new version of Cutline is available.',
          detail: 'Your project is saved. Reload to update.',
          timeout: 0,
          action: {
            label: 'Reload now',
            run: () => {
              worker.postMessage({ type: 'SKIP_WAITING' });
            },
          },
        });
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
        });
      });
      // The first install also fires controllerchange (clients.claim); only an
      // update that replaces an existing controller should reload the page.
      let hadController = !!navigator.serviceWorker.controller;
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) {
          hadController = true;
          return;
        }
        if (reloading) return;
        reloading = true;
        window.location.reload();
      });
      // Check for updates periodically while the editor stays open.
      setInterval(() => void reg.update().catch(() => {}), 60 * 60 * 1000);
    } catch (e) {
      console.warn('Service worker registration failed', e);
    }
  });
}
