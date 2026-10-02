/**
 * The project document model.
 *
 * Everything the editor, preview, and exporter know about a project lives in
 * this structure. It is plain, serializable data (no class instances) so it
 * can be stored in IndexedDB, posted to workers, diffed for undo/redo, and
 * validated on import.
 *
 * Time is expressed in seconds (float64). Editing operations quantize to the
 * project frame grid when snapping is enabled; rendering samples at n / fps.
 */

export type ID = string;

export const PROJECT_SCHEMA_VERSION = 1;

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  /** Canvas color behind all layers (hex, e.g. "#000000"). */
  background: string;
  sampleRate: number;
  /** The user picked the format (so imports don't change it). */
  chosen?: boolean;
}

export type AssetKind = 'video' | 'audio' | 'image' | 'font';

export type AssetStatus =
  /** File is being copied into local storage / analysed. */
  | 'processing'
  /** Ready to use. */
  | 'ready'
  /** Metadata exists but the media file is not available (needs relink). */
  | 'missing'
  /** The file could not be decoded. */
  | 'error';

export interface AssetVideoInfo {
  width: number;
  height: number;
  /** Clockwise rotation from container metadata. Width/height are pre-rotation coded display size. */
  rotation: 0 | 90 | 180 | 270;
  fps: number;
  codec: string | null;
  hasAlpha: boolean;
}

export interface AssetAudioInfo {
  sampleRate: number;
  channels: number;
  codec: string | null;
  /** True once decoded PCM + waveform peaks are available locally. */
  conformed: boolean;
  /** Strength of the noise-reduced PCM variant, if one has been made. */
  denoise?: 'light' | 'medium' | 'strong';
}

export interface Asset {
  id: ID;
  kind: AssetKind;
  name: string;
  mimeType: string;
  size: number;
  /** Last-modified timestamp of the original file (used to match relinks). */
  lastModified: number;
  /** Seconds. 0 for still images and fonts. */
  duration: number;
  video?: AssetVideoInfo;
  audio?: AssetAudioInfo;
  /** For still images: intrinsic pixel size. */
  image?: { width: number; height: number; animated?: boolean };
  /** For fonts: the CSS family name it is registered under. */
  font?: { family: string };
  status: AssetStatus;
  error?: string;
  /** Whether the bytes live in the origin-private file system (survive reloads). */
  stored: boolean;
  createdAt: number;
}

export type TrackKind = 'video' | 'audio' | 'caption';

export interface Track {
  id: ID;
  kind: TrackKind;
  name: string;
  hidden: boolean;
  muted: boolean;
  /** When any track is soloed, only soloed tracks are heard. */
  solo?: boolean;
  locked: boolean;
  /** Linear gain multiplier applied to every clip on the track. */
  volume: number;
  /** UI height in px. */
  height: number;
  /** Only for caption tracks: shared caption styling. */
  captionStyle?: CaptionStyle;
}

export type Easing =
  | 'linear'
  | 'easeIn'
  | 'easeOut'
  | 'easeInOut'
  | 'hold'
  | 'backOut'
  | 'elasticOut'
  | 'bounceOut';

export interface Keyframe {
  id: ID;
  /** Seconds relative to the clip's start on the timeline. */
  t: number;
  v: number;
  /** Interpolation used from this keyframe to the next one. */
  ease: Easing;
}

/** Map of animatable property path -> keyframes sorted by time. */
export type KeyframeMap = Record<string, Keyframe[]>;

export interface Transform {
  /** Offset of the layer's center from the frame center, in project pixels. */
  x: number;
  y: number;
  /** Uniform scale relative to the fitted size. 1 = fitted. */
  scale: number;
  /** Degrees clockwise. */
  rotation: number;
  /** 0..1 */
  opacity: number;
}

/** Crop insets as fractions (0..1) of the source size. */
export interface Crop {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export type FitMode = 'contain' | 'cover' | 'fill' | 'none';

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'add'
  | 'difference'
  | 'softLight';

export interface ColorAdjust {
  exposure: number; // -2..2 stops
  contrast: number; // -1..1
  saturation: number; // -1..1
  temperature: number; // -1..1
  tint: number; // -1..1
  highlights: number; // -1..1
  shadows: number; // -1..1
  vibrance: number; // -1..1
  hue: number; // -180..180 degrees
}

export interface Effect {
  id: ID;
  /** Key into the effect registry (core/effects.ts). */
  type: string;
  enabled: boolean;
  params: Record<string, number | string | boolean>;
  /** Added by a one-click look (replaced when another look is applied). */
  look?: boolean;
}

export type AnimationPreset =
  | 'none'
  | 'fade'
  | 'slideLeft'
  | 'slideRight'
  | 'slideUp'
  | 'slideDown'
  | 'zoomIn'
  | 'zoomOut'
  | 'pop'
  | 'spin'
  | 'blur'
  | 'wipe'
  | 'typewriter'
  | 'wordByWord';

export interface ClipAnimation {
  preset: AnimationPreset;
  /** Seconds. */
  duration: number;
}

export interface TransitionSpec {
  /** Key into the transition registry (core/transitions.ts). */
  type: string;
  /** Total duration in seconds, centered on the cut. */
  duration: number;
}

export interface TextStyle {
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  /** In project pixels. */
  fontSize: number;
  color: string;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  /** In em. */
  letterSpacing: number;
  uppercase: boolean;
  strokeColor: string;
  /** In project pixels; 0 = none. */
  strokeWidth: number;
  shadowColor: string;
  /** 0 = no shadow. */
  shadowBlur: number;
  shadowX: number;
  shadowY: number;
  /** Background box color with alpha (e.g. "#000000"), null = none. */
  backgroundColor: string | null;
  backgroundOpacity: number;
  backgroundPadding: number;
  backgroundRadius: number;
  /** Wrap width as a fraction of the frame width. */
  maxWidth: number;
}

export interface CaptionStyle extends TextStyle {
  /** Vertical placement anchor. */
  position: 'bottom' | 'middle' | 'top';
  /** Distance from the anchored edge as a fraction of frame height. */
  margin: number;
  /** Highlight color for the currently spoken word (when word timings exist). */
  activeWordColor: string | null;
}

export interface ClipBase {
  id: ID;
  trackId: ID;
  /** Timeline start, seconds. */
  start: number;
  /** Timeline duration, seconds. */
  duration: number;
  name: string;
  /** Optional label color for the timeline. */
  labelColor?: string;
  /** Disabled clips are kept on the timeline but not rendered. */
  disabled?: boolean;
  keyframes: KeyframeMap;
}

export interface VisualProps {
  transform: Transform;
  crop: Crop;
  fit: FitMode;
  flipH: boolean;
  flipV: boolean;
  blendMode: BlendMode;
  color: ColorAdjust;
  effects: Effect[];
  animIn: ClipAnimation;
  animOut: ClipAnimation;
  /** Transition from this clip into the adjacent following clip on the same track. */
  transitionOut?: TransitionSpec;
  /** Rounded corners as a fraction of the shorter side (0..0.5). */
  cornerRadius: number;
}

export interface AudioProps {
  /** Linear gain (1 = unity). */
  volume: number;
  /** Play the asset's noise-reduced audio (see AssetAudioInfo.denoise). */
  denoise: boolean;
  /** -1 (left) .. 1 (right). */
  pan: number;
  fadeIn: number;
  fadeOut: number;
  muted: boolean;
}

export interface MediaSourceProps {
  assetId: ID;
  /** Source time (seconds) shown at the clip's first frame. */
  sourceIn: number;
  /** Playback rate. 0.1 .. 16. */
  speed: number;
  /** Preserve pitch when speed != 1. */
  preservePitch: boolean;
}

export interface VideoClip extends ClipBase, VisualProps, AudioProps, MediaSourceProps {
  type: 'video';
  /** Freeze the frame at sourceIn (still frame from a video). */
  freeze?: boolean;
}

export interface AudioClip extends ClipBase, AudioProps, MediaSourceProps {
  type: 'audio';
}

export interface ImageClip extends ClipBase, VisualProps {
  type: 'image';
  assetId: ID;
}

export interface TextClip extends ClipBase, VisualProps {
  type: 'text';
  text: string;
  style: TextStyle;
}

export type ShapeKind = 'rectangle' | 'ellipse' | 'triangle' | 'star' | 'line' | 'arrow';

export interface ShapeClip extends ClipBase, VisualProps {
  type: 'shape';
  shape: ShapeKind;
  /** Project pixels. */
  width: number;
  height: number;
  fill: string;
  /** Second color for gradients; null = solid fill. */
  fill2: string | null;
  gradientAngle: number;
  strokeColor: string;
  strokeWidth: number;
  /** Rectangle corner radius in px. */
  radius: number;
}

export interface AdjustmentClip extends ClipBase {
  type: 'adjustment';
  color: ColorAdjust;
  effects: Effect[];
  /** 0..1 strength of the adjustment. */
  opacity: number;
}

export interface CaptionWord {
  text: string;
  /** Seconds relative to the caption clip start. */
  start: number;
  end: number;
}

export interface CaptionClip extends ClipBase {
  type: 'caption';
  text: string;
  /** Optional word-level timings (e.g. from transcription) for karaoke highlighting. */
  words?: CaptionWord[];
}

export type Clip =
  | VideoClip
  | AudioClip
  | ImageClip
  | TextClip
  | ShapeClip
  | AdjustmentClip
  | CaptionClip;

export type ClipType = Clip['type'];

export type VisualClip = VideoClip | ImageClip | TextClip | ShapeClip;
export type AudibleClip = VideoClip | AudioClip;

export interface Marker {
  id: ID;
  t: number;
  label: string;
  color: string;
}

export interface Project {
  schemaVersion: number;
  id: ID;
  name: string;
  createdAt: number;
  updatedAt: number;
  settings: ProjectSettings;
  assets: Record<ID, Asset>;
  /** Display order, top to bottom. Visual tracks (video/caption) come before audio tracks. */
  tracks: Track[];
  clips: Record<ID, Clip>;
  markers: Marker[];
  /** Optional export/work range (seconds). */
  inPoint: number | null;
  outPoint: number | null;
  masterVolume: number;
}

export function isVisualClip(c: Clip): c is VisualClip {
  return c.type === 'video' || c.type === 'image' || c.type === 'text' || c.type === 'shape';
}

export function isAudibleClip(c: Clip): c is AudibleClip {
  return c.type === 'video' || c.type === 'audio';
}

export function isMediaClip(c: Clip): c is VideoClip | AudioClip | ImageClip {
  return c.type === 'video' || c.type === 'audio' || c.type === 'image';
}

export function hasSourceTiming(c: Clip): c is VideoClip | AudioClip {
  return c.type === 'video' || c.type === 'audio';
}
