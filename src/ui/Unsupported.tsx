/**
 * Hard requirements. We check them up front and explain clearly instead of
 * failing in confusing ways later.
 */
export function missingFeatures(): string[] {
  const missing: string[] = [];
  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') missing.push('WebCodecs (video decoding/encoding)');
  if (typeof OffscreenCanvas === 'undefined') missing.push('OffscreenCanvas');
  try {
    const c = document.createElement('canvas');
    if (!c.getContext('webgl2')) missing.push('WebGL 2');
  } catch {
    missing.push('WebGL 2');
  }
  if (typeof indexedDB === 'undefined') missing.push('IndexedDB (local project storage)');
  if (typeof Worker === 'undefined') missing.push('Web Workers');
  return missing;
}

export function Unsupported({ missing }: { missing: string[] }) {
  return (
    <div className="unsupported">
      <div className="card">
        <h1 style={{ margin: 0, fontSize: 22 }}>This browser can’t run Cutline yet</h1>
        <p className="muted" style={{ margin: 0 }}>
          Cutline edits video entirely on your device, which needs a few modern browser features that are missing here:
        </p>
        <ul style={{ textAlign: 'left', color: 'var(--text-2)' }}>
          {missing.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
        <p className="muted" style={{ margin: 0 }}>
          Please open Cutline in a current version of <strong>Chrome</strong>, <strong>Edge</strong>, <strong>Firefox</strong> or <strong>Safari</strong> on a computer. If you’re already using one, check that hardware acceleration is turned on.
        </p>
      </div>
    </div>
  );
}
