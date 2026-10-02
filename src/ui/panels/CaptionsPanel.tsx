import { useMemo, useState } from 'react';
import { Download, FileText, Plus, Trash2, Upload, Wand2 } from 'lucide-react';
import { chunkTranscript, toSRT, toVTT } from '@/core/captions';
import { addTrack, frameCues, makeRoomFor } from '@/core/ops';
import { clipsOnTrack, createCaptionClip, scaledCaptionStyle } from '@/core/project';
import { formatTimecode } from '@/core/time';
import type { CaptionClip } from '@/core/types';
import * as A from '@/state/actions';
import { editor, toast, useEditor, usePlayback } from '@/state/store';
import { player } from '@/playback/player';
import { downloadBlob } from '@/ui/download';
import { openImportPicker } from '../importPicker';
import { PanelHead } from './LeftDock';
import { AutoCaptions, useCaptionJob } from './AutoCaptions';

export function CaptionsPanel() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const selectedTrackId = useEditor((s) => s.selectedTrackId);
  // The panel works on one caption track at a time: the selected one, else the first.
  const captionTracks = project.tracks.filter((t) => t.kind === 'caption');
  const track = captionTracks.find((t) => t.id === selectedTrackId) ?? captionTracks[0];
  const captions = useMemo(() => (track ? (clipsOnTrack(project, track.id) as CaptionClip[]) : []), [project, track]);
  const [pasting, setPasting] = useState(false);
  const [auto, setAuto] = useState(false);
  const jobRunning = useCaptionJob((s) => s.running);
  const [transcript, setTranscript] = useState('');
  // Re-render when the caption under the playhead changes, not on every playback frame.
  const activeId = usePlayback((s) => captions.find((c) => s.time >= c.start && s.time < c.start + c.duration)?.id ?? null);
  const time = usePlayback((s) => (pasting ? s.time : 0));

  const fps = project.settings.fps;

  const exportCaptions = (kind: 'srt' | 'vtt') => {
    const cues = captions.map((c) => ({ start: c.start, end: c.start + c.duration, text: c.text }));
    const text = kind === 'srt' ? toSRT(cues) : toVTT(cues);
    downloadBlob(new Blob([text], { type: kind === 'srt' ? 'application/x-subrip' : 'text/vtt' }), `${project.name}.${kind}`);
  };

  const addTranscript = () => {
    const cues = chunkTranscript(transcript, usePlayback.getState().time);
    if (!cues.length) return;
    editor().commit('Add captions', (d) => {
      let t = d.tracks.find((x) => x.id === track?.id);
      if (!t) {
        t = addTrack(d, 'caption');
        t.captionStyle = scaledCaptionStyle(d.settings.height);
      }
      const ids: string[] = [];
      for (const c of frameCues(d, cues)) {
        const clip = createCaptionClip({ trackId: t.id, start: c.qStart, duration: c.qEnd - c.qStart }, c.text);
        d.clips[clip.id] = clip;
        ids.push(clip.id);
      }
      makeRoomFor(d, ids, 'overwrite');
    });
    toast({ kind: 'success', message: `Added ${cues.length} captions. Adjust their timing on the timeline.` });
    setTranscript('');
    setPasting(false);
  };

  return (
    <>
      <PanelHead title="Captions">
        {captions.length > 0 && (
          <button className="btn small" onClick={() => A.addCaptionAt()} data-tip="Add a caption at the playhead">
            <Plus size={14} /> Add
          </button>
        )}
      </PanelHead>
      {(auto || jobRunning) && <AutoCaptions onClose={() => setAuto(false)} />}
      <div className="panel-body">
        {captionTracks.length > 1 && (
          <label className="field" style={{ marginBottom: 10 }}>
            <span className="label">Track</span>
            <select className="select" aria-label="Caption track" value={track?.id} onChange={(e) => editor().set('selectedTrackId', e.target.value)}>
              {captionTracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {captions.length === 0 && !pasting && !auto && (
          <div className="col">
            <p className="panel-hint" style={{ marginTop: 0 }}>
              Captions live on their own track, share one style, and are burned into the export. You can also download them as SRT or VTT.
            </p>
            <button className="tile wide" onClick={() => A.addCaptionAt()}>
              <Plus size={18} />
              <span>
                <strong>Add caption at playhead</strong>
                <br />
                <span className="subtle">Type captions as you go</span>
              </span>
            </button>
            <button className="tile wide" onClick={() => openImportPicker({}, '.srt,.vtt')}>
              <Upload size={18} />
              <span>
                <strong>Import SRT / VTT</strong>
                <br />
                <span className="subtle">Use an existing subtitle file</span>
              </span>
            </button>
            <button className="tile wide" onClick={() => setPasting(true)}>
              <FileText size={18} />
              <span>
                <strong>Paste a transcript</strong>
                <br />
                <span className="subtle">Split into timed captions automatically</span>
              </span>
            </button>
            <button className="tile wide" onClick={() => setAuto(true)}>
              <Wand2 size={18} />
              <span>
                <strong>Generate automatically</strong>
                <br />
                <span className="subtle">Speech-to-text on your device, with word timing</span>
              </span>
            </button>
          </div>
        )}
        {pasting && (
          <div className="col">
            <label className="subtle" htmlFor="transcript">
              Paste or type the spoken text. It will be split into captions starting at the playhead ({formatTimecode(time, fps)}).
            </label>
            <textarea id="transcript" className="input" rows={8} value={transcript} onChange={(e) => setTranscript(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            <div className="row">
              <button className="btn" onClick={() => setPasting(false)}>
                Cancel
              </button>
              <button className="btn primary grow" disabled={!transcript.trim()} onClick={addTranscript}>
                Create captions
              </button>
            </div>
          </div>
        )}
        {captions.length > 0 && !pasting && (
          <>
            <div className="row" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
              <button className="btn small" onClick={() => exportCaptions('srt')}>
                <Download size={13} /> SRT
              </button>
              <button className="btn small" onClick={() => exportCaptions('vtt')}>
                <Download size={13} /> VTT
              </button>
              <button className="btn small" onClick={() => setPasting(true)}>
                <FileText size={13} /> Paste
              </button>
              <button className="btn small" onClick={() => openImportPicker({}, '.srt,.vtt')}>
                <Upload size={13} /> Import
              </button>
              <button className="btn small" onClick={() => setAuto(true)} aria-label="Generate captions automatically" data-tip="Generate captions automatically">
                <Wand2 size={13} /> Auto
              </button>
            </div>
            <button
              className="btn small block"
              style={{ marginBottom: 10 }}
              onClick={() => {
                if (track) {
                  editor().select([]);
                  editor().set('selectedTrackId', track.id);
                }
              }}
            >
              Edit caption style…
            </button>
            <ol className="caption-list" aria-label="Captions">
              {captions.map((c) => {
                const active = c.id === activeId;
                return (
                  <li key={c.id} className={`caption-item${selection.includes(c.id) ? ' selected' : ''}${active ? ' active' : ''}`}>
                    <button
                      className="caption-time mono"
                      onClick={() => {
                        player.seek(c.start);
                        editor().select([c.id]);
                      }}
                      aria-label={`Go to caption at ${formatTimecode(c.start, fps)}`}
                    >
                      {formatTimecode(c.start, fps).slice(3)}
                    </button>
                    <CaptionText clip={c} />
                    <button
                      className="icon-btn tiny"
                      aria-label="Delete caption"
                      onClick={() => editor().commit('Delete caption', (d) => void delete d.clips[c.id])}
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </div>
    </>
  );
}

function CaptionText({ clip }: { clip: CaptionClip }) {
  const [v, setV] = useState(clip.text);
  const [focused, setFocused] = useState(false);
  const shown = focused ? v : clip.text;
  return (
    <textarea
      className="caption-text"
      aria-label="Caption text"
      rows={Math.max(1, Math.ceil(shown.length / 22))}
      value={shown}
      onFocus={() => {
        setV(clip.text);
        setFocused(true);
        editor().select([clip.id]);
        player.seek(clip.start + 0.001);
      }}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        setFocused(false);
        if (v !== clip.text)
          editor().commit('Edit caption', (d) => {
            const c = d.clips[clip.id];
            if (c?.type === 'caption') {
              c.text = v;
              c.name = v.slice(0, 40);
              c.words = undefined;
            }
          });
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
    />
  );
}
