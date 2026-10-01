import type { ClipAnimation, TextStyle } from './types';

export interface TextPreset {
  id: string;
  name: string;
  text: string;
  style: Partial<TextStyle>;
  /** Vertical placement as a fraction of frame height from center (-0.5 top .. 0.5 bottom). */
  y?: number;
  x?: number;
  animIn?: ClipAnimation;
  animOut?: ClipAnimation;
  effects?: { type: string; params?: Record<string, number | string | boolean> }[];
}

export const TEXT_PRESETS: TextPreset[] = [
  { id: 'title', name: 'Title', text: 'Your Title', style: { fontFamily: 'Inter', fontWeight: 800, fontSize: 120 }, animIn: { preset: 'fade', duration: 0.5 }, animOut: { preset: 'fade', duration: 0.5 } },
  { id: 'subtitle', name: 'Subtitle', text: 'A short subtitle', style: { fontFamily: 'Inter', fontWeight: 500, fontSize: 56, color: '#e8e8e8' }, y: 0.12 },
  { id: 'lower', name: 'Lower third', text: 'Alex Morgan\nProduct Designer', style: { fontFamily: 'Inter', fontWeight: 700, fontSize: 48, align: 'left', backgroundColor: '#111111', backgroundOpacity: 0.75, backgroundPadding: 0.35, backgroundRadius: 0.12, maxWidth: 0.5 }, y: 0.32, x: -0.28, animIn: { preset: 'slideRight', duration: 0.5 }, animOut: { preset: 'fade', duration: 0.4 } },
  { id: 'impact', name: 'Bold impact', text: 'BIG NEWS', style: { fontFamily: 'Anton', fontWeight: 400, fontSize: 160, uppercase: true, strokeColor: '#000000', strokeWidth: 6 }, animIn: { preset: 'pop', duration: 0.4 } },
  { id: 'social', name: 'Social caption', text: 'wait for it…', style: { fontFamily: 'Poppins', fontWeight: 800, fontSize: 72, color: '#ffffff', strokeColor: '#000000', strokeWidth: 8 }, y: 0.22, animIn: { preset: 'pop', duration: 0.3 } },
  { id: 'highlight', name: 'Highlight box', text: 'Key takeaway', style: { fontFamily: 'Montserrat', fontWeight: 800, fontSize: 64, color: '#111111', backgroundColor: '#ffd84d', backgroundOpacity: 1, backgroundPadding: 0.3, backgroundRadius: 0.1 }, animIn: { preset: 'wipe', duration: 0.5 } },
  { id: 'quote', name: 'Quote', text: '“Simplicity is the ultimate sophistication.”', style: { fontFamily: 'Playfair Display', fontWeight: 400, italic: true, fontSize: 72, maxWidth: 0.7, lineHeight: 1.3 }, animIn: { preset: 'blur', duration: 0.8 } },
  { id: 'neon', name: 'Neon', text: 'OPEN LATE', style: { fontFamily: 'Righteous', fontWeight: 400, fontSize: 130, color: '#ff4fd8', shadowColor: '#ff4fd8', shadowBlur: 30, shadowX: 0, shadowY: 0 }, effects: [{ type: 'glow', params: { strength: 90, radius: 30, threshold: 40 } }], animIn: { preset: 'fade', duration: 0.6 } },
  { id: 'outline', name: 'Outline', text: 'OUTLINE', style: { fontFamily: 'Archivo Black', fontWeight: 400, fontSize: 140, color: '#00000000', strokeColor: '#ffffff', strokeWidth: 4, uppercase: true } },
  { id: 'handwritten', name: 'Handwritten', text: 'summer memories', style: { fontFamily: 'Caveat', fontWeight: 700, fontSize: 110, color: '#fff7e6' }, animIn: { preset: 'wipe', duration: 1 } },
  { id: 'script', name: 'Script', text: 'Happy Birthday', style: { fontFamily: 'Pacifico', fontWeight: 400, fontSize: 110, color: '#ffffff', shadowColor: '#00000088', shadowBlur: 12, shadowY: 6 }, animIn: { preset: 'zoomIn', duration: 0.6 } },
  { id: 'typewriter', name: 'Typewriter', text: 'Once upon a time…', style: { fontFamily: 'Roboto Mono', fontWeight: 400, fontSize: 60, align: 'left', maxWidth: 0.8 }, animIn: { preset: 'typewriter', duration: 1.5 } },
  { id: 'cinematic', name: 'Cinematic', text: 'C H A P T E R  O N E', style: { fontFamily: 'Montserrat', fontWeight: 400, fontSize: 54, letterSpacing: 0.25 }, animIn: { preset: 'fade', duration: 1.2 }, animOut: { preset: 'fade', duration: 1.2 } },
  { id: 'comic', name: 'Comic', text: 'POW!', style: { fontFamily: 'Bangers', fontWeight: 400, fontSize: 180, color: '#ffe14d', strokeColor: '#1a1a1a', strokeWidth: 8, shadowColor: '#e63946', shadowBlur: 0.01, shadowX: 10, shadowY: 10 }, animIn: { preset: 'spin', duration: 0.5 } },
  { id: 'body', name: 'Body text', text: 'Add a paragraph of text here. It wraps automatically to fit the frame.', style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 44, maxWidth: 0.6, lineHeight: 1.4, align: 'left' } },
];
