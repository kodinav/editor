import { startBusy } from '@/state/busy';
import { useEffect, useRef, useState } from 'react';
import { Circle, Square, X } from 'lucide-react';
import { formatDuration } from '@/core/time';
import { importFiles } from '@/state/importer';
import { editor, toast, usePlayback } from '@/state/store';
import { player } from '@/playback/player';

/**
 * Record a voiceover from the microphone straight into the timeline at the
 * playhead. Recording happens locally with MediaRecorder; the result is
 * imported like any other audio file.
 */
export function VoiceoverRecorder({ onClose }: { onClose: () => void }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [state, setState] = useState<'idle' | 'starting' | 'recording' | 'saving'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [playAlong, setPlayAlong] = useState(true);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const startAt = useRef(0);
  const startTime = useRef(0);

  useEffect(() => {
    let ctx: AudioContext | null = null;
    let raf = 0;
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = stream;
        const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
        setDevices(list);
        ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser();
        an.fftSize = 1024;
        src.connect(an);
        const buf = new Float32Array(an.fftSize);
        const tick = () => {
          an.getFloatTimeDomainData(buf);
          let m = 0;
          for (const v of buf) m = Math.max(m, Math.abs(v));
          setLevel(m);
          raf = requestAnimationFrame(tick);
        };
        tick();
        setError(null);
      } catch (e) {
        const name = (e as DOMException).name;
        setError(name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in your browser’s site settings.' : name === 'NotFoundError' ? 'No microphone was found.' : String((e as Error).message));
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      void ctx?.close();
    };
  }, [deviceId]);

  useEffect(
    () => () => {
      recRef.current?.state === 'recording' && recRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  useEffect(() => {
    if (state !== 'recording') return;
    const id = setInterval(() => setElapsed((performance.now() - startAt.current) / 1000), 200);
    return () => clearInterval(id);
  }, [state]);

  const start = () => {
    const stream = streamRef.current;
    if (!stream) return;
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 160000 } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = startBusy('a voiceover recording');
    rec.onstop = async () => {
      done();
      setState('saving');
      player.pause();
      const type = rec.mimeType || 'audio/webm';
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '-');
      const file = new File(chunks, `Voiceover ${stamp}.${ext}`, { type, lastModified: Date.now() });
      // Place on a free audio track at the time recording started.
      const p = editor().project;
      const dur = (performance.now() - startAt.current) / 1000;
      const track = freeAudioTrack(p, startTime.current, startTime.current + dur);
      await importFiles([file], { place: { time: startTime.current, trackId: track } });
      setState('idle');
      setElapsed(0);
    };
    startTime.current = usePlayback.getState().time;
    startAt.current = performance.now();
    rec.start(1000);
    recRef.current = rec;
    setState('recording');
    if (playAlong) void player.play();
  };

  const stop = () => {
    recRef.current?.stop();
  };

  return (
    <div className="recorder" role="region" aria-label="Voiceover recorder">
      <div className="row">
        <strong className="grow">Record voiceover</strong>
        <button className="icon-btn tiny" aria-label="Close recorder" onClick={onClose} disabled={state === 'recording'}>
          <X size={14} />
        </button>
      </div>
      {error ? (
        <div className="callout err">{error}</div>
      ) : (
        <>
          <select className="select" aria-label="Microphone" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} disabled={state !== 'idle'}>
            <option value="">Default microphone</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || 'Microphone'}
              </option>
            ))}
          </select>
          <div className="meter" aria-label="Input level">
            <div style={{ width: `${Math.min(100, Math.sqrt(level) * 100)}%`, background: level > 0.9 ? 'var(--danger)' : undefined }} />
          </div>
          <label className="row" style={{ fontSize: 12 }}>
            <input type="checkbox" checked={playAlong} onChange={(e) => setPlayAlong(e.target.checked)} disabled={state !== 'idle'} />
            Play the timeline while recording
          </label>
          <div className="row">
            {state === 'recording' ? (
              <button className="btn danger grow" onClick={stop}>
                <Square size={13} fill="currentColor" /> Stop · {formatDuration(elapsed)}
              </button>
            ) : (
              <button className="btn primary grow" onClick={start} disabled={state !== 'idle'}>
                <Circle size={13} fill="currentColor" /> {state === 'saving' ? 'Saving…' : 'Record at playhead'}
              </button>
            )}
          </div>
          <p className="subtle" style={{ margin: 0, fontSize: 11.5 }}>
            Tip: use headphones so the timeline audio isn’t recorded.
          </p>
        </>
      )}
    </div>
  );
}

function freeAudioTrack(p: ReturnType<typeof editor>['project'], start: number, end: number): string | undefined {
  // Read-only check: prefer an existing free audio track; importer creates one if needed.
  const t = p.tracks.filter((x) => x.kind === 'audio' && !x.locked).find((x) =>
    Object.values(p.clips).every((c) => c.trackId !== x.id || c.start + c.duration <= start || c.start >= end),
  );
  if (!t) toast({ kind: 'info', message: 'Added a new audio track for the voiceover.', timeout: 2000 });
  return t?.id;
}
