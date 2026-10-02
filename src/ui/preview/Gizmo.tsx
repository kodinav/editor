import { useRef, useState } from 'react';
import { isActiveAt } from '@/core/evaluate';
import { hitTest, rotatePoint, toLocal, visibleCorners, type LayerGeometry } from '@/core/geometry';
import { evalProp, writeProp } from '@/core/keyframes';
import type { Clip } from '@/core/types';
import { isVisualClip } from '@/core/types';
import { usePreviewInfo } from '@/playback/player';
import { editor, useEditor, usePlayback } from '@/state/store';

/**
 * On-canvas manipulation of the selected layer: drag to move (with snapping
 * to the frame center/edges), corner handles to scale, top handle to rotate.
 * Writes go through writeProp, so animated properties get keyframes at the
 * playhead automatically. Clicking empty canvas selects the layer under the
 * pointer (topmost first).
 */

const SNAP_PX = 7;

interface Guide {
  x?: number;
  y?: number;
}

export function Gizmo({ stageW, stageH }: { stageW: number; stageH: number }) {
  const selection = useEditor((s) => s.selection);
  const project = useEditor((s) => s.project);
  const bounds = usePreviewInfo((s) => s.bounds);
  const playing = usePlayback((s) => s.playing);
  const time = usePlayback((s) => s.time);
  const [guides, setGuides] = useState<Guide>({});
  const [dragging, setDragging] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  const W = project.settings.width;
  const H = project.settings.height;
  const k = stageW / W; // screen px per project px

  const selId = selection.length === 1 ? selection[0] : null;
  const sel = selId ? project.clips[selId] : null;
  const g = selId ? bounds.get(selId) : undefined;
  const editable = sel && isVisualClip(sel) && isActiveAt(sel, time) && !isLocked(sel);

  const toProject = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  };

  const pickAt = (pt: { x: number; y: number }): string | null => {
    // Bounds are stored in render order (bottom → top); search from the top.
    const entries = [...bounds.entries()].reverse();
    for (const [id, geom] of entries) {
      const c = project.clips[id];
      if (!c || isLocked(c)) continue;
      if (hitTest(geom, pt, 2 / k)) return id;
    }
    return null;
  };

  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const pt = toProject(e);
    const id = pickAt(pt);
    if (id) {
      if (e.shiftKey || e.metaKey || e.ctrlKey) editor().select([id], { toggle: true });
      else if (!selection.includes(id)) editor().select([id]);
      const c = project.clips[id];
      if (c && isVisualClip(c) && selection.length <= 1) startMove(e, id, bounds.get(id)!);
    } else {
      editor().select([]);
    }
  };

  function localT(c: Clip) {
    return Math.min(Math.max(usePlayback.getState().time - c.start, 0), c.duration);
  }

  function capture(e: React.PointerEvent, onMove: (ev: PointerEvent) => void, label: string) {
    e.preventDefault();
    e.stopPropagation();
    const id = e.pointerId;
    (e.currentTarget as Element).setPointerCapture(id);
    editor().beginGesture(label);
    setDragging(true);
    // Listen on the window: the handle may unmount mid-drag (Escape deselects, Delete removes
    // the clip), and the gesture must still end when the pointer is released.
    const move = (ev: PointerEvent) => {
      if (ev.pointerId === id) onMove(ev);
    };
    const finish = (ev: PointerEvent, keep: boolean) => {
      if (ev.pointerId !== id) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (keep) editor().endGesture();
      else editor().cancelGesture();
      setGuides({});
      setDragging(false);
    };
    const up = (ev: PointerEvent) => finish(ev, true);
    const cancel = (ev: PointerEvent) => finish(ev, false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }

  function startMove(e: React.PointerEvent, id: string, geom: LayerGeometry) {
    const c = editor().project.clips[id];
    if (!c || !isVisualClip(c)) return;
    const start = toProject(e);
    const lt = localT(c);
    const baseX = evalProp(c, 'transform.x', lt);
    const baseY = evalProp(c, 'transform.y', lt);
    const halfW = Math.abs(geom.vis.x1 - geom.vis.x0) / 2;
    const halfH = Math.abs(geom.vis.y1 - geom.vis.y0) / 2;
    const offX = (geom.vis.x0 + geom.vis.x1) / 2;
    const offY = (geom.vis.y0 + geom.vis.y1) / 2;
    capture(
      e,
      (ev) => {
        const p = toProject(ev);
        let nx = baseX + (p.x - start.x);
        let ny = baseY + (p.y - start.y);
        const guide: Guide = {};
        if (!ev.altKey && geom.rotation % 90 === 0) {
          const tol = SNAP_PX / k;
          // Candidate x positions: layer center/edges vs frame center/edges.
          const cx = W / 2 + nx + offX;
          const cy = H / 2 + ny + offY;
          const xs: [number, number][] = [
            [cx, W / 2],
            [cx - halfW, 0],
            [cx + halfW, W],
          ];
          const ys: [number, number][] = [
            [cy, H / 2],
            [cy - halfH, 0],
            [cy + halfH, H],
          ];
          for (const [v, target] of xs)
            if (Math.abs(v - target) < tol) {
              nx += target - v;
              guide.x = target;
              break;
            }
          for (const [v, target] of ys)
            if (Math.abs(v - target) < tol) {
              ny += target - v;
              guide.y = target;
              break;
            }
        }
        setGuides(guide);
        editor().updateGesture((d) => {
          const dc = d.clips[id];
          if (!dc) return;
          const t = localT(dc);
          writeProp(dc, 'transform.x', t, Math.round(nx * 10) / 10);
          writeProp(dc, 'transform.y', t, Math.round(ny * 10) / 10);
        });
      },
      'Move layer',
    );
  }

  function startScale(e: React.PointerEvent, id: string, geom: LayerGeometry) {
    const c = editor().project.clips[id];
    if (!c || !isVisualClip(c)) return;
    const lt = localT(c);
    const baseScale = evalProp(c, 'transform.scale', lt);
    const start = toProject(e);
    const d0 = Math.hypot(start.x - geom.cx, start.y - geom.cy) || 1;
    capture(
      e,
      (ev) => {
        const p = toProject(ev);
        const d1 = Math.hypot(p.x - geom.cx, p.y - geom.cy);
        let s = Math.max(0.01, baseScale * (d1 / d0));
        if (ev.shiftKey) s = Math.round(s * 20) / 20;
        // Gentle snap to 100%.
        if (!ev.altKey && Math.abs(s - 1) < 0.03) s = 1;
        editor().updateGesture((d) => {
          const dc = d.clips[id];
          if (dc) writeProp(dc, 'transform.scale', localT(dc), Math.round(s * 1000) / 1000);
        });
      },
      'Scale layer',
    );
  }

  function startRotate(e: React.PointerEvent, id: string, geom: LayerGeometry) {
    const c = editor().project.clips[id];
    if (!c || !isVisualClip(c)) return;
    const lt = localT(c);
    const baseRot = evalProp(c, 'transform.rotation', lt);
    const start = toProject(e);
    const a0 = Math.atan2(start.y - geom.cy, start.x - geom.cx);
    capture(
      e,
      (ev) => {
        const p = toProject(ev);
        const a1 = Math.atan2(p.y - geom.cy, p.x - geom.cx);
        let r = baseRot + ((a1 - a0) * 180) / Math.PI;
        if (ev.shiftKey) r = Math.round(r / 15) * 15;
        else if (!ev.altKey) {
          const near = Math.round(r / 90) * 90;
          if (Math.abs(r - near) < 3) r = near;
        }
        editor().updateGesture((d) => {
          const dc = d.clips[id];
          if (dc) writeProp(dc, 'transform.rotation', localT(dc), Math.round(r * 10) / 10);
        });
      },
      'Rotate layer',
    );
  }

  type Edge = { l?: boolean; r?: boolean; t?: boolean; b?: boolean };
  function startCrop(e: React.PointerEvent, id: string, geom: LayerGeometry, edge: Edge) {
    const c = editor().project.clips[id];
    if (!c || !isVisualClip(c)) return;
    capture(
      e,
      (ev) => {
        const lp = toLocal(geom, toProject(ev));
        // Fractions of the full (uncropped) rect, measured from each edge.
        const fx = (lp.x + geom.w / 2) / geom.w;
        const fy = (lp.y + geom.h / 2) / geom.h;
        editor().updateGesture((d) => {
          const dc = d.clips[id];
          if (!dc || !isVisualClip(dc)) return;
          const t = localT(dc);
          const cur = { left: evalProp(dc, 'crop.left', t), right: evalProp(dc, 'crop.right', t), top: evalProp(dc, 'crop.top', t), bottom: evalProp(dc, 'crop.bottom', t) };
          const minGap = 0.02;
          const cl = (v: number, max: number) => Math.round(Math.min(Math.max(0, v), max) * 1000) / 1000;
          if (edge.l) writeProp(dc, 'crop.left', t, cl(fx, 1 - cur.right - minGap));
          if (edge.r) writeProp(dc, 'crop.right', t, cl(1 - fx, 1 - cur.left - minGap));
          if (edge.t) writeProp(dc, 'crop.top', t, cl(fy, 1 - cur.bottom - minGap));
          if (edge.b) writeProp(dc, 'crop.bottom', t, cl(1 - fy, 1 - cur.top - minGap));
        });
      },
      'Crop',
    );
  }

  const corners = g ? visibleCorners(g).map((p) => ({ x: p.x * k, y: p.y * k })) : [];
  const cropMode = useEditor((s) => s.cropMode);
  const canCrop = !!sel && (sel.type === 'video' || sel.type === 'image');
  const showBox = !playing && g && sel && editable;
  const showCrop = showBox && cropMode && canCrop;
  // Full (uncropped) rectangle outline for crop mode.
  const fullCorners =
    showCrop && g
      ? [
          { x: -g.w / 2, y: -g.h / 2 },
          { x: g.w / 2, y: -g.h / 2 },
          { x: g.w / 2, y: g.h / 2 },
          { x: -g.w / 2, y: g.h / 2 },
        ].map((p) => {
          const r = rotatePoint(p, g.rotation);
          return { x: (r.x + g.cx) * k, y: (r.y + g.cy) * k };
        })
      : [];
  const isCaption = sel?.type === 'caption';
  let rotHandle: { x: number; y: number } | null = null;
  if (showBox && corners.length === 4) {
    const mx = (corners[0].x + corners[1].x) / 2;
    const my = (corners[0].y + corners[1].y) / 2;
    const cx = g!.cx * k;
    const cy = g!.cy * k;
    const len = Math.hypot(mx - cx, my - cy) || 1;
    rotHandle = { x: mx + ((mx - cx) / len) * 22, y: my + ((my - cy) / len) * 22 };
  }

  return (
    <svg
      ref={svgRef}
      className={`gizmo${dragging ? ' dragging' : ''}`}
      width={stageW}
      height={stageH}
      onPointerDown={onBackgroundDown}
      onDoubleClick={() => {
        if (sel?.type === 'text') document.getElementById('text-content-input')?.focus();
      }}
    >
      {guides.x !== undefined && <line className="guide" x1={guides.x * k} x2={guides.x * k} y1={0} y2={stageH} />}
      {guides.y !== undefined && <line className="guide" y1={guides.y * k} y2={guides.y * k} x1={0} x2={stageW} />}
      {/* Outline for other selected layers */}
      {!playing &&
        selection.length > 1 &&
        selection.map((id) => {
          const b = bounds.get(id);
          if (!b) return null;
          const pts = visibleCorners(b).map((p) => `${p.x * k},${p.y * k}`).join(' ');
          return <polygon key={id} className="gizmo-outline" points={pts} />;
        })}
      {showCrop && corners.length === 4 && (
        <g className="crop-ui">
          <path
            className="crop-full"
            fillRule="evenodd"
            d={`M${fullCorners.map((p) => `${p.x},${p.y}`).join('L')}Z M${corners.map((p) => `${p.x},${p.y}`).join('L')}Z`}
          />
          <polygon className="gizmo-box" points={corners.map((p) => `${p.x},${p.y}`).join(' ')} />
          {(
            [
              [0, { l: true, t: true }, 'nwse-resize'],
              [1, { r: true, t: true }, 'nesw-resize'],
              [2, { r: true, b: true }, 'nwse-resize'],
              [3, { l: true, b: true }, 'nesw-resize'],
            ] as const
          ).map(([i, edge, cursor]) => (
            <rect key={`c${i}`} className="crop-handle" x={corners[i].x - 6} y={corners[i].y - 6} width={12} height={12} style={{ cursor }} onPointerDown={(e) => startCrop(e, selId!, g!, edge)}>
              <title>Crop corner</title>
            </rect>
          ))}
          {(
            [
              [0, 1, { t: true }, 'ns-resize'],
              [1, 2, { r: true }, 'ew-resize'],
              [2, 3, { b: true }, 'ns-resize'],
              [3, 0, { l: true }, 'ew-resize'],
            ] as const
          ).map(([a, b, edge, cursor]) => (
            <rect
              key={`e${a}`}
              className="crop-handle edge"
              x={(corners[a].x + corners[b].x) / 2 - 7}
              y={(corners[a].y + corners[b].y) / 2 - 7}
              width={14}
              height={14}
              style={{ cursor }}
              onPointerDown={(e) => startCrop(e, selId!, g!, edge)}
            >
              <title>Crop edge</title>
            </rect>
          ))}
        </g>
      )}
      {showBox && !showCrop && corners.length === 4 && (
        <g>
          <polygon
            className="gizmo-box"
            points={corners.map((p) => `${p.x},${p.y}`).join(' ')}
            onPointerDown={(e) => {
              if (e.button !== 0 || isCaption) return;
              startMove(e, selId!, g!);
            }}
            style={{ cursor: isCaption ? 'default' : 'move' }}
          />
          {!isCaption && (
            <>
              {rotHandle && (
                <>
                  <line className="gizmo-stem" x1={(corners[0].x + corners[1].x) / 2} y1={(corners[0].y + corners[1].y) / 2} x2={rotHandle.x} y2={rotHandle.y} />
                  <circle className="gizmo-rot" cx={rotHandle.x} cy={rotHandle.y} r={5.5} onPointerDown={(e) => startRotate(e, selId!, g!)}>
                    <title>Rotate (Shift snaps to 15°)</title>
                  </circle>
                </>
              )}
              {corners.map((p, i) => (
                <rect key={i} className="gizmo-handle" x={p.x - 5} y={p.y - 5} width={10} height={10} rx={2} onPointerDown={(e) => startScale(e, selId!, g!)} style={{ cursor: i % 2 === 0 ? 'nwse-resize' : 'nesw-resize' }}>
                  <title>Scale</title>
                </rect>
              ))}
            </>
          )}
        </g>
      )}
    </svg>
  );
}

function isLocked(c: Clip): boolean {
  const t = editor().project.tracks.find((x) => x.id === c.trackId);
  return !!t?.locked;
}
