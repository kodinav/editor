import { NEUTRAL_COLOR } from './effects';
import { uid } from './ids';
import {
  PROJECT_SCHEMA_VERSION,
  type AdjustmentClip,
  type Asset,
  type AudioClip,
  type CaptionClip,
  type CaptionStyle,
  type Clip,
  type ImageClip,
  type Project,
  type ProjectSettings,
  type ShapeClip,
  type ShapeKind,
  type TextClip,
  type TextStyle,
  type Track,
  type TrackKind,
  type VideoClip,
  type VisualProps,
  type AudioProps,
} from './types';

export interface FormatPreset {
  id: string;
  label: string;
  hint: string;
  width: number;
  height: number;
}

export const FORMAT_PRESETS: FormatPreset[] = [
  { id: '16:9', label: 'Landscape 16:9', hint: 'YouTube, TV', width: 1920, height: 1080 },
  { id: '9:16', label: 'Vertical 9:16', hint: 'TikTok, Reels, Shorts', width: 1080, height: 1920 },
  { id: '1:1', label: 'Square 1:1', hint: 'Instagram feed', width: 1080, height: 1080 },
  { id: '4:5', label: 'Portrait 4:5', hint: 'Instagram, Facebook', width: 1080, height: 1350 },
  { id: '4:3', label: 'Classic 4:3', hint: 'Presentations', width: 1440, height: 1080 },
  { id: '21:9', label: 'Cinema 21:9', hint: 'Widescreen', width: 2560, height: 1080 },
  { id: '4k', label: '4K UHD 16:9', hint: '3840 × 2160', width: 3840, height: 2160 },
];

export const FPS_OPTIONS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

export const DEFAULT_SETTINGS: ProjectSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  background: '#000000',
  sampleRate: 48000,
};

export function createTrack(kind: TrackKind, name: string): Track {
  return {
    id: uid('trk'),
    kind,
    name,
    hidden: false,
    muted: false,
    locked: false,
    volume: 1,
    height: kind === 'audio' ? 56 : kind === 'caption' ? 40 : 64,
    captionStyle: kind === 'caption' ? defaultCaptionStyle() : undefined,
  };
}

export function createProject(name = 'Untitled project', settings: Partial<ProjectSettings> = {}): Project {
  const now = Date.now();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: uid('prj'),
    name,
    createdAt: now,
    updatedAt: now,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    assets: {},
    tracks: [createTrack('video', 'Video 2'), createTrack('video', 'Video 1'), createTrack('audio', 'Audio 1')],
    clips: {},
    markers: [],
    inPoint: null,
    outPoint: null,
    masterVolume: 1,
  };
}

export function defaultVisualProps(): VisualProps {
  return {
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    crop: { left: 0, right: 0, top: 0, bottom: 0 },
    fit: 'contain',
    flipH: false,
    flipV: false,
    blendMode: 'normal',
    color: { ...NEUTRAL_COLOR },
    effects: [],
    animIn: { preset: 'none', duration: 0.5 },
    animOut: { preset: 'none', duration: 0.5 },
    cornerRadius: 0,
  };
}

export function defaultAudioProps(): AudioProps {
  return { volume: 1, denoise: false, pan: 0, fadeIn: 0, fadeOut: 0, muted: false };
}

export function defaultTextStyle(overrides: Partial<TextStyle> = {}): TextStyle {
  return {
    fontFamily: 'Inter',
    fontWeight: 700,
    italic: false,
    fontSize: 96,
    color: '#ffffff',
    align: 'center',
    lineHeight: 1.15,
    letterSpacing: 0,
    uppercase: false,
    strokeColor: '#000000',
    strokeWidth: 0,
    shadowColor: '#000000',
    shadowBlur: 0,
    shadowX: 0,
    shadowY: 4,
    backgroundColor: null,
    backgroundOpacity: 0.7,
    backgroundPadding: 0.3,
    backgroundRadius: 0.2,
    maxWidth: 0.9,
    ...overrides,
  };
}

export function defaultCaptionStyle(): CaptionStyle {
  return {
    ...defaultTextStyle({
      fontSize: 54,
      fontWeight: 700,
      backgroundColor: '#000000',
      backgroundOpacity: 0.6,
      backgroundPadding: 0.25,
      backgroundRadius: 0.15,
      maxWidth: 0.8,
      lineHeight: 1.2,
    }),
    position: 'bottom',
    margin: 0.08,
    activeWordColor: null,
  };
}

/** Scale a caption style authored for 1080p to another frame height. */
export function scaledCaptionStyle(height: number): CaptionStyle {
  const s = defaultCaptionStyle();
  const k = Math.min(height, 1920) / 1080;
  return { ...s, fontSize: Math.round(s.fontSize * Math.max(0.6, k)) };
}

interface ClipPlacement {
  trackId: string;
  start: number;
  duration: number;
}

export function createVideoClip(asset: Asset, p: ClipPlacement): VideoClip {
  return {
    id: uid('clp'),
    type: 'video',
    name: asset.name,
    trackId: p.trackId,
    start: p.start,
    duration: p.duration,
    keyframes: {},
    assetId: asset.id,
    sourceIn: 0,
    speed: 1,
    preservePitch: true,
    ...defaultVisualProps(),
    ...defaultAudioProps(),
  };
}

export function createAudioClip(asset: Asset, p: ClipPlacement): AudioClip {
  return {
    id: uid('clp'),
    type: 'audio',
    name: asset.name,
    trackId: p.trackId,
    start: p.start,
    duration: p.duration,
    keyframes: {},
    assetId: asset.id,
    sourceIn: 0,
    speed: 1,
    preservePitch: true,
    ...defaultAudioProps(),
  };
}

export function createImageClip(asset: Asset, p: ClipPlacement): ImageClip {
  return {
    id: uid('clp'),
    type: 'image',
    name: asset.name,
    trackId: p.trackId,
    start: p.start,
    duration: p.duration,
    keyframes: {},
    assetId: asset.id,
    ...defaultVisualProps(),
  };
}

export function createTextClip(p: ClipPlacement, text = 'Your title', style: Partial<TextStyle> = {}): TextClip {
  return {
    id: uid('clp'),
    type: 'text',
    name: text.split('\n')[0].slice(0, 40) || 'Text',
    trackId: p.trackId,
    start: p.start,
    duration: p.duration,
    keyframes: {},
    text,
    style: defaultTextStyle(style),
    ...defaultVisualProps(),
    fit: 'none',
  };
}

export function createShapeClip(
  p: ClipPlacement,
  shape: ShapeKind,
  opts: Partial<Pick<ShapeClip, 'width' | 'height' | 'fill' | 'fill2' | 'radius' | 'strokeColor' | 'strokeWidth' | 'gradientAngle'>> = {},
): ShapeClip {
  const names: Record<ShapeKind, string> = {
    rectangle: 'Rectangle',
    ellipse: 'Ellipse',
    triangle: 'Triangle',
    star: 'Star',
    line: 'Line',
    arrow: 'Arrow',
  };
  return {
    id: uid('clp'),
    type: 'shape',
    name: names[shape],
    trackId: p.trackId,
    start: p.start,
    duration: p.duration,
    keyframes: {},
    shape,
    width: 400,
    height: shape === 'line' ? 12 : 400,
    fill: '#4f8cff',
    fill2: null,
    gradientAngle: 90,
    strokeColor: '#ffffff',
    strokeWidth: 0,
    radius: 0,
    ...defaultVisualProps(),
    fit: 'none',
    ...opts,
  };
}

export function createAdjustmentClip(p: ClipPlacement): AdjustmentClip {
  return {
    id: uid('clp'),
    type: 'adjustment',
    name: 'Adjustment layer',
    trackId: p.trackId,
    start: p.start,
    duration: p.duration,
    keyframes: {},
    color: { ...NEUTRAL_COLOR },
    effects: [],
    opacity: 1,
  };
}

export function createCaptionClip(p: ClipPlacement, text: string): CaptionClip {
  return {
    id: uid('clp'),
    type: 'caption',
    name: text.slice(0, 40),
    trackId: p.trackId,
    start: p.start,
    duration: p.duration,
    keyframes: {},
    text,
  };
}

export function projectDuration(project: Project): number {
  let end = 0;
  for (const c of Object.values(project.clips)) {
    const e = c.start + c.duration;
    if (e > end) end = e;
  }
  return end;
}

export function clipEnd(c: Clip): number {
  return c.start + c.duration;
}

export function clipsOnTrack(project: Project, trackId: string): Clip[] {
  const out: Clip[] = [];
  for (const c of Object.values(project.clips)) if (c.trackId === trackId) out.push(c);
  out.sort((a, b) => a.start - b.start);
  return out;
}

export function trackById(project: Project, id: string): Track | undefined {
  return project.tracks.find((t) => t.id === id);
}

export function isVisualTrackKind(kind: TrackKind): boolean {
  return kind === 'video' || kind === 'caption';
}

/** Which track kind can hold which clip type. */
export function trackAccepts(kind: TrackKind, clipType: Clip['type']): boolean {
  switch (kind) {
    case 'video':
      return clipType === 'video' || clipType === 'image' || clipType === 'text' || clipType === 'shape' || clipType === 'adjustment';
    case 'audio':
      return clipType === 'audio';
    case 'caption':
      return clipType === 'caption';
  }
}

export function nextTrackName(project: Project, kind: TrackKind): string {
  const base = kind === 'video' ? 'Video' : kind === 'audio' ? 'Audio' : 'Captions';
  let n = 1;
  const names = new Set(project.tracks.map((t) => t.name));
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}
