import type { VideoSample } from 'mediabunny';
import { EFFECT_MAP, isNeutralColor } from '@/core/effects';
import type { AdjustmentLayer, ClipLayer, FrameDesc, ResolvedEffect, TransitionLayer } from '@/core/evaluate';
import { layerGeometry, type LayerGeometry, type Size } from '@/core/geometry';
import type { BlendMode, ColorAdjust, ShapeClip, TextStyle } from '@/core/types';
import {
  affine,
  createQuad,
  FULLSCREEN,
  hexToRgb,
  IDENTITY3,
  mul3,
  Program,
  setSampling,
  TargetPool,
  type GL,
  type RenderTarget,
} from './gl';
import * as S from './shaders';
import { renderShape } from './shapes';
import { renderText } from './text';

/**
 * WebGL2 compositor. Consumes a FrameDesc (from core/evaluate) and draws it.
 * Used for the live preview (main thread) and for export (worker) — same code,
 * same shaders, same output.
 *
 * Coordinate conventions: render targets store row 0 = top of the image, so
 * all offscreen drawing uses a y-down clip space. Only the final present to
 * the canvas flips.
 */

export interface FrameSources {
  /** Decoded frame for a video clip (keyed by clip id), or null if not ready. */
  video(clipId: string): VideoSample | null;
  /** Decoded still image (or the frame of an animated image at `time`), or null if not loaded yet. */
  image(assetId: string, time: number): ImageBitmap | null;
}

export interface RenderResult {
  /** Geometry of each drawn clip in project pixels (for gizmos / hit testing). */
  bounds: Map<string, LayerGeometry>;
  /** Some source (video frame/image) was not available. */
  missing: boolean;
  /** Text was drawn with fallback fonts because a font is still loading. */
  fontsPending: boolean;
}

interface Source {
  tex: WebGLTexture;
  /** Intrinsic display size (after rotation) used for fitting. */
  size: Size;
  /** Unrotated texture aspect info. */
  rotation: 0 | 90 | 180 | 270;
  flip: boolean;
  /** Pixels available in the source (for capping processing resolution). */
  px: Size;
}

interface CachedRaster {
  tex: WebGLTexture;
  w: number;
  h: number;
  pxW: number;
  pxH: number;
  used: number;
}

const BLEND_IDS: Record<BlendMode, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  add: 6,
  difference: 7,
  softLight: 8,
};

export class Compositor {
  readonly gl: GL;
  private quad: WebGLVertexArrayObject;
  private pool: TargetPool;
  private programs = new Map<string, Program>();
  private videoTex = new Map<string, { tex: WebGLTexture; sample: VideoSample | null; ts: number; w: number; h: number }>();
  private imageTex = new Map<string, { tex: WebGLTexture; bmp: ImageBitmap; w: number; h: number; used: number }>();
  private rasters = new Map<string, CachedRaster>();
  private frameCounter = 0;
  private W = 1;
  private H = 1;
  private scale = 1;
  private time = 0;
  private result!: RenderResult;
  lost = false;

  constructor(
    readonly canvas: HTMLCanvasElement | OffscreenCanvas,
    opts: { preserveDrawingBuffer?: boolean } = {},
  ) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
      powerPreference: 'high-performance',
    }) as GL | null;
    if (!gl) throw new Error('WebGL 2 is not available in this browser.');
    this.gl = gl;
    this.quad = createQuad(gl);
    this.pool = new TargetPool(gl);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    (canvas as HTMLCanvasElement).addEventListener?.('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
  }

  private prog(name: string, src: string): Program {
    let p = this.programs.get(name);
    if (!p) {
      p = new Program(this.gl, src);
      this.programs.set(name, p);
    }
    return p;
  }

  /* ------------------------------------------------------------------ */

  render(desc: FrameDesc, sources: FrameSources, scale: number): RenderResult {
    const gl = this.gl;
    this.frameCounter++;
    this.W = desc.width;
    this.H = desc.height;
    this.scale = scale;
    this.time = desc.time;
    this.result = { bounds: new Map(), missing: false, fontsPending: false };
    const rw = Math.max(1, Math.round(desc.width * scale));
    const rh = Math.max(1, Math.round(desc.height * scale));
    if (this.canvas.width !== rw || this.canvas.height !== rh) {
      this.canvas.width = rw;
      this.canvas.height = rh;
    }
    gl.bindVertexArray(this.quad);

    let acc = this.pool.acquire(rw, rh);
    const [br, bg, bb] = hexToRgb(desc.background);
    gl.bindFramebuffer(gl.FRAMEBUFFER, acc.fbo);
    gl.viewport(0, 0, rw, rh);
    gl.clearColor(br, bg, bb, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    for (const layer of desc.layers) {
      if (layer.type === 'clip') {
        acc = this.compositeClip(layer, sources, acc);
      } else if (layer.type === 'transition') {
        acc = this.compositeTransition(layer, sources, acc);
      } else {
        acc = this.compositeAdjustment(layer, acc);
      }
    }

    // Present: flip vertically into the default framebuffer.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, rw, rh);
    gl.disable(gl.BLEND);
    const copy = this.prog('copy', S.COPY_FS);
    copy.use();
    copy.m3('uMatrix', FULLSCREEN);
    copy.m3('uUVMatrix', affine(1, 0, 0, -1, 0, 1));
    this.bindTex(0, acc.tex);
    copy.i1('uTex', 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.pool.release(acc);
    if (this.frameCounter % 120 === 0) this.gcRasters();
    return this.result;
  }

  /* ----------------------------- sources ----------------------------- */

  private bindTex(unit: number, tex: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  private videoSource(clipId: string, sample: VideoSample | null): Source | null {
    const gl = this.gl;
    if (!sample) return null;
    let entry = this.videoTex.get(clipId);
    if (!entry) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      setSampling(gl, gl.LINEAR, gl.LINEAR);
      entry = { tex, sample: null, ts: -1, w: 0, h: 0 };
      this.videoTex.set(clipId, entry);
    }
    if (entry.sample !== sample || entry.ts !== sample.timestamp) {
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      try {
        const img = sample.toCanvasImageSource();
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img as TexImageSource);
      } catch (e) {
        console.warn('Video frame upload failed', e);
        return null;
      }
      entry.sample = sample;
      entry.ts = sample.timestamp;
      entry.w = sample.squarePixelWidth;
      entry.h = sample.squarePixelHeight;
    }
    const rot = sample.rotation;
    const swap = rot === 90 || rot === 270;
    const size = swap ? { w: entry.h, h: entry.w } : { w: entry.w, h: entry.h };
    return { tex: entry.tex, size, rotation: rot, flip: sample.flip, px: size };
  }

  private imageSource(assetId: string, bmp: ImageBitmap | null): Source | null {
    const gl = this.gl;
    if (!bmp) return null;
    let entry = this.imageTex.get(assetId);
    if (!entry) {
      const tex = gl.createTexture()!;
      entry = { tex, bmp: null as unknown as ImageBitmap, w: 0, h: 0, used: this.frameCounter };
      this.imageTex.set(assetId, entry);
    }
    if (entry.bmp !== bmp) {
      // New image, or the next frame of an animation: upload into the same texture.
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
      gl.generateMipmap(gl.TEXTURE_2D);
      setSampling(gl, gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR);
      entry.bmp = bmp;
      entry.w = bmp.width;
      entry.h = bmp.height;
    }
    entry.used = this.frameCounter;
    return { tex: entry.tex, size: { w: entry.w, h: entry.h }, rotation: 0, flip: false, px: { w: entry.w, h: entry.h } };
  }

  /** Quantize render scale to half-octave steps so animated scale doesn't re-rasterize every frame. */
  private rasterScale(layerScale: number): number {
    const raw = this.scale * Math.max(0.25, layerScale);
    const q = Math.pow(2, Math.ceil(Math.log2(Math.max(raw, 0.05)) * 2) / 2);
    return Math.min(q, 4);
  }

  private raster(key: string, make: () => { canvas: OffscreenCanvas; w: number; h: number; complete?: boolean }): CachedRaster {
    let r = this.rasters.get(key);
    if (r) {
      r.used = this.frameCounter;
      return r;
    }
    const gl = this.gl;
    const out = make();
    if (out.complete === false) this.result.fontsPending = true;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, out.canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    setSampling(gl, gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR);
    r = { tex, w: out.w, h: out.h, pxW: out.canvas.width, pxH: out.canvas.height, used: this.frameCounter };
    // Don't cache fallback-font renders: re-rasterize once the font arrives.
    if (out.complete !== false) this.rasters.set(key, r);
    else queueMicrotask(() => gl.deleteTexture(tex));
    return r;
  }

  private gcRasters() {
    for (const [k, r] of this.rasters) {
      if (this.frameCounter - r.used > 240) {
        this.gl.deleteTexture(r.tex);
        this.rasters.delete(k);
      }
    }
    // Photos can be large (a 4K still with mipmaps is ~85 MB of VRAM); free idle ones.
    for (const [k, e] of this.imageTex) {
      if (this.frameCounter - e.used > 240) {
        this.gl.deleteTexture(e.tex);
        this.imageTex.delete(k);
      }
    }
    this.pool.trim();
  }

  private textSource(text: string, style: TextStyle, layerScale: number, visibleChars: number | null, highlight: { start: number; end: number; color: string } | null): Source {
    const rs = this.rasterScale(layerScale);
    const key = `t|${rs}|${this.W}|${visibleChars}|${highlight ? `${highlight.start}-${highlight.end}-${highlight.color}` : ''}|${text}|${JSON.stringify(style)}`;
    const r = this.raster(key, () => renderText(text, style, { scale: rs, frameWidth: this.W, visibleChars, highlight }));
    return { tex: r.tex, size: { w: r.w, h: r.h }, rotation: 0, flip: false, px: { w: r.pxW, h: r.pxH } };
  }

  private shapeSource(c: ShapeClip, layerScale: number): Source {
    const rs = this.rasterScale(layerScale);
    const key = `s|${rs}|${c.shape}|${c.width}|${c.height}|${c.fill}|${c.fill2}|${c.gradientAngle}|${c.strokeColor}|${c.strokeWidth}|${c.radius}`;
    const r = this.raster(key, () => renderShape(c, rs));
    return { tex: r.tex, size: { w: r.w, h: r.h }, rotation: 0, flip: false, px: { w: r.pxW, h: r.pxH } };
  }

  private sourceFor(l: ClipLayer, sources: FrameSources): Source | null {
    const s = l.source;
    switch (s.kind) {
      case 'video':
        return this.videoSource(l.clipId, sources.video(l.clipId));
      case 'image':
        return this.imageSource(s.assetId, sources.image(s.assetId, s.time));
      case 'text':
        return this.textSource(s.clip.text, s.clip.style, l.scale, s.visibleChars, null);
      case 'shape':
        return this.shapeSource(s.clip, l.scale);
      case 'caption': {
        const words = s.clip.words;
        let highlight: { start: number; end: number; color: string } | null = null;
        if (words && s.style.activeWordColor) {
          // Map active word to a character range in the caption text.
          let pos = 0;
          for (const w of words) {
            const idx = s.clip.text.indexOf(w.text, pos);
            if (idx < 0) continue;
            pos = idx + w.text.length;
            if (s.localTime >= w.start && s.localTime < w.end) {
              highlight = { start: idx, end: idx + w.text.length, color: s.style.activeWordColor };
              break;
            }
          }
        }
        return this.textSource(s.clip.text, s.style, 1, null, highlight);
      }
    }
  }

  /* --------------------------- clip drawing --------------------------- */

  /** Caption layers are positioned by their track style rather than a transform. */
  private captionOffset(l: ClipLayer, size: Size): { x: number; y: number } {
    if (l.source.kind !== 'caption') return { x: l.x, y: l.y };
    const st = l.source.style;
    const H = this.H;
    if (st.position === 'top') return { x: 0, y: -H / 2 + st.margin * H + size.h / 2 };
    if (st.position === 'middle') return { x: 0, y: 0 };
    return { x: 0, y: H / 2 - st.margin * H - size.h / 2 };
  }

  /** Map unit-quad coords of the visible rect to source texture UVs (crop, flips, rotation). */
  private uvMatrix(l: ClipLayer, src: Source): Float32Array {
    const c = l.crop;
    let m = affine(1 - c.left - c.right, 0, 0, 1 - c.top - c.bottom, c.left, c.top);
    if (l.flipH) m = mul3(affine(-1, 0, 0, 1, 1, 0), m);
    if (l.flipV) m = mul3(affine(1, 0, 0, -1, 0, 1), m);
    if (src.flip) m = mul3(affine(-1, 0, 0, 1, 1, 0), m);
    switch (src.rotation) {
      case 90:
        m = mul3(affine(0, -1, 1, 0, 0, 1), m); // (u,v) -> (v, 1-u)
        break;
      case 180:
        m = mul3(affine(-1, 0, 0, -1, 1, 1), m);
        break;
      case 270:
        m = mul3(affine(0, 1, -1, 0, 1, 0), m); // (u,v) -> (1-v, u)
        break;
    }
    return m;
  }

  /** Unit quad -> y-down clip space for a target covering the whole frame. */
  private quadMatrix(g: LayerGeometry): Float32Array {
    const r = (g.rotation * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const vw = g.vis.x1 - g.vis.x0;
    const vh = g.vis.y1 - g.vis.y0;
    const sx = 2 / this.W;
    const sy = 2 / this.H;
    const a = cos * vw;
    const b = sin * vw;
    const c = -sin * vh;
    const d = cos * vh;
    const ex = cos * g.vis.x0 - sin * g.vis.y0 + g.cx;
    const ey = sin * g.vis.x0 + cos * g.vis.y0 + g.cy;
    return new Float32Array([a * sx, b * sy, 0, c * sx, d * sy, 0, ex * sx - 1, ey * sy - 1, 1]);
  }

  /**
   * Draw a clip layer onto `target` (full-frame render target) using normal
   * premultiplied "over" blending. Returns false if nothing was drawn.
   */
  private drawClip(l: ClipLayer, sources: FrameSources, target: RenderTarget): boolean {
    const gl = this.gl;
    const src = this.sourceFor(l, sources);
    if (!src) {
      this.result.missing = true;
      return false;
    }
    const pos = this.captionOffset(l, src.size);
    const g = layerGeometry({ ...l, x: pos.x, y: pos.y }, src.size, { w: this.W, h: this.H });
    const visW = g.vis.x1 - g.vis.x0;
    const visH = g.vis.y1 - g.vis.y0;
    if (visW <= 0.01 || visH <= 0.01) return false;
    // Report geometry even for fully transparent layers so they stay selectable.
    this.result.bounds.set(l.clipId, g);
    if (l.opacity <= 0.001) return false;

    let tex = src.tex;
    let uv = this.uvMatrix(l, src);
    let processed: RenderTarget | null = null;
    const needsProcessing = l.effects.length > 0 || !isNeutralColor(l.color) || l.animBlur > 0.5;
    if (needsProcessing) {
      // Process at the displayed size, capped by available source pixels.
      const c = l.crop;
      const srcVisW = src.px.w * (1 - c.left - c.right);
      const srcVisH = src.px.h * (1 - c.top - c.bottom);
      const dispW = visW * this.scale;
      const dispH = visH * this.scale;
      const k = Math.min(1, srcVisW / Math.max(1, dispW), srcVisH / Math.max(1, dispH));
      const pw = Math.max(1, Math.min(4096, Math.round(dispW * k)));
      const ph = Math.max(1, Math.min(4096, Math.round(dispH * k)));
      const pxScale = pw / visW; // processing px per project px
      let rt = this.pool.acquire(pw, ph);
      this.pass(this.prog('copy', S.COPY_FS), src.tex, rt, () => {}, uv);
      if (!isNeutralColor(l.color)) rt = this.colorPass(rt, l.color);
      for (const fx of l.effects) rt = this.applyEffect(fx, rt, pxScale, l.localTime);
      if (l.animBlur > 0.5) rt = this.blur(rt, l.animBlur * 0.5 * pxScale);
      processed = rt;
      tex = rt.tex;
      uv = IDENTITY3;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const p = this.prog('draw', S.DRAW_FS);
    p.use();
    p.m3('uMatrix', this.quadMatrix(g));
    p.m3('uUVMatrix', uv);
    this.bindTex(0, tex);
    p.i1('uTex', 0);
    p.f1('uOpacity', l.opacity);
    p.f2('uSize', visW * this.scale, visH * this.scale);
    p.f1('uRadius', l.cornerRadius * Math.min(visW, visH) * this.scale);
    p.f1('uWipe', l.wipe ?? 1);
    // Mipmapped sampling for heavy downscales of video (prevents shimmering).
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.BLEND);
    this.pool.release(processed);
    return true;
  }

  private compositeClip(l: ClipLayer, sources: FrameSources, acc: RenderTarget): RenderTarget {
    if (l.blendMode === 'normal') {
      this.drawClip(l, sources, acc);
      return acc;
    }
    const layer = this.pool.acquire(acc.w, acc.h);
    this.clear(layer);
    const drawn = this.drawClip(l, sources, layer);
    if (!drawn) {
      this.pool.release(layer);
      return acc;
    }
    const out = this.pool.acquire(acc.w, acc.h);
    const bp = this.prog('blend', S.BLEND_FS);
    this.pass(bp, layer.tex, out, (p) => {
      this.bindTex(1, acc.tex);
      p.i1('uBase', 1);
      p.i1('uMode', BLEND_IDS[l.blendMode]);
    });
    this.pool.release(layer);
    this.pool.release(acc);
    return out;
  }

  private compositeTransition(t: TransitionLayer, sources: FrameSources, acc: RenderTarget): RenderTarget {
    const gl = this.gl;
    const a = this.pool.acquire(acc.w, acc.h);
    const b = this.pool.acquire(acc.w, acc.h);
    this.clear(a);
    this.clear(b);
    this.drawClip(t.a, sources, a);
    this.drawClip(t.b, sources, b);
    const src = S.TRANSITION_FS[t.transition] ?? S.TRANSITION_FS.crossfade;
    const prog = this.prog('tr:' + t.transition, src);
    const mixed = this.pool.acquire(acc.w, acc.h);
    this.pass(prog, a.tex, mixed, (p) => {
      this.bindTex(1, b.tex);
      p.i1('uB', 1);
      p.f1('uP', t.progress);
      p.f2('uRes', acc.w, acc.h);
    });
    this.pool.release(a);
    this.pool.release(b);
    // Composite the transition result over the accumulator.
    gl.bindFramebuffer(gl.FRAMEBUFFER, acc.fbo);
    gl.viewport(0, 0, acc.w, acc.h);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const copy = this.prog('copy', S.COPY_FS);
    copy.use();
    copy.m3('uMatrix', FULLSCREEN);
    copy.m3('uUVMatrix', IDENTITY3);
    this.bindTex(0, mixed.tex);
    copy.i1('uTex', 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.BLEND);
    this.pool.release(mixed);
    return acc;
  }

  private compositeAdjustment(l: AdjustmentLayer, acc: RenderTarget): RenderTarget {
    if (l.opacity <= 0.001) return acc;
    let rt = this.pool.acquire(acc.w, acc.h);
    this.pass(this.prog('copy', S.COPY_FS), acc.tex, rt, () => {});
    if (!isNeutralColor(l.color)) rt = this.colorPass(rt, l.color);
    const pxScale = acc.w / this.W;
    for (const fx of l.effects) rt = this.applyEffect(fx, rt, pxScale, l.localTime);
    if (l.opacity >= 0.999) {
      this.pool.release(acc);
      return rt;
    }
    const out = this.pool.acquire(acc.w, acc.h);
    this.pass(this.prog('mix', S.MIX_FS), acc.tex, out, (p) => {
      this.bindTex(1, rt.tex);
      p.i1('uOther', 1);
      p.f1('uAmount', l.opacity);
    });
    this.pool.release(rt);
    this.pool.release(acc);
    return out;
  }

  /* ----------------------------- passes ----------------------------- */

  private clear(rt: RenderTarget) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
    gl.viewport(0, 0, rt.w, rt.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private pass(p: Program, input: WebGLTexture, out: RenderTarget, setup: (p: Program) => void, uv: Float32Array = IDENTITY3, inSize?: Size) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    gl.viewport(0, 0, out.w, out.h);
    gl.disable(gl.BLEND);
    p.use();
    p.m3('uMatrix', FULLSCREEN);
    p.m3('uUVMatrix', uv);
    this.bindTex(0, input);
    p.i1('uTex', 0);
    p.f2('uTexSize', inSize?.w ?? out.w, inSize?.h ?? out.h);
    setup(p);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** Run a single-input shader pass, returning a new target and releasing the input. */
  private simple(rt: RenderTarget, name: string, src: string, setup: (p: Program) => void): RenderTarget {
    const out = this.pool.acquire(rt.w, rt.h);
    this.pass(this.prog(name, src), rt.tex, out, setup);
    this.pool.release(rt);
    return out;
  }

  private colorPass(rt: RenderTarget, c: ColorAdjust): RenderTarget {
    return this.simple(rt, 'color', S.COLOR_FS, (p) => {
      p.f1('uExposure', c.exposure);
      p.f1('uContrast', c.contrast);
      p.f1('uSaturation', c.saturation);
      p.f1('uVibrance', c.vibrance);
      p.f1('uTemp', c.temperature);
      p.f1('uTint', c.tint);
      p.f1('uHighlights', c.highlights);
      p.f1('uShadows', c.shadows);
      p.f1('uHue', c.hue);
    });
  }

  /** Gaussian blur with sigma in target pixels; downsamples for large radii. */
  private blur(rt: RenderTarget, sigma: number): RenderTarget {
    if (sigma < 0.3) return rt;
    const factor = Math.max(1, Math.min(16, Math.floor(sigma / 6)));
    let work = rt;
    if (factor > 1) {
      const small = this.pool.acquire(Math.max(1, Math.round(rt.w / factor)), Math.max(1, Math.round(rt.h / factor)));
      this.pass(this.prog('copy', S.COPY_FS), rt.tex, small, () => {});
      work = small;
    }
    const s = sigma / factor;
    const bp = this.prog('blur', S.BLUR_FS);
    const tmp = this.pool.acquire(work.w, work.h);
    this.pass(bp, work.tex, tmp, (p) => {
      p.f2('uDir', 1 / work.w, 0);
      p.f1('uSigma', s);
    });
    const out2 = this.pool.acquire(work.w, work.h);
    this.pass(bp, tmp.tex, out2, (p) => {
      p.f2('uDir', 0, 1 / work.h);
      p.f1('uSigma', s);
    });
    this.pool.release(tmp);
    if (factor > 1) {
      this.pool.release(work);
      const up = this.pool.acquire(rt.w, rt.h);
      this.pass(this.prog('copy', S.COPY_FS), out2.tex, up, () => {});
      this.pool.release(out2);
      this.pool.release(rt);
      return up;
    }
    this.pool.release(rt);
    return out2;
  }

  private num(fx: ResolvedEffect, key: string): number {
    const v = fx.params[key];
    if (typeof v === 'number') return v;
    const def = EFFECT_MAP[fx.type]?.params.find((p) => p.key === key);
    return def && def.kind === 'number' ? def.default : 0;
  }

  private str(fx: ResolvedEffect, key: string): string {
    const v = fx.params[key];
    if (typeof v === 'string') return v;
    const def = EFFECT_MAP[fx.type]?.params.find((p) => p.key === key);
    return def && (def.kind === 'color' || def.kind === 'select') ? def.default : '';
  }

  /** pxScale: processing pixels per project pixel (keeps effects resolution-independent). */
  private applyEffect(fx: ResolvedEffect, rt: RenderTarget, pxScale: number, localTime: number): RenderTarget {
    const n = (k: string) => this.num(fx, k);
    switch (fx.type) {
      case 'blur':
        return this.blur(rt, n('amount') * 0.5 * pxScale);
      case 'directionalBlur': {
        const len = n('amount') * 1.2 * pxScale;
        const a = (n('angle') * Math.PI) / 180;
        return this.simple(rt, 'dirblur', S.DIRBLUR_FS, (p) => p.f2('uDir', (Math.cos(a) * len) / rt.w, (Math.sin(a) * len) / rt.h));
      }
      case 'zoomBlur':
        return this.simple(rt, 'zoomblur', S.ZOOMBLUR_FS, (p) => p.f1('uAmount', (n('amount') / 100) * 0.35));
      case 'sharpen':
        return this.simple(rt, 'sharpen', S.SHARPEN_FS, (p) => p.f1('uAmount', n('amount') / 100));
      case 'vignette':
        return this.simple(rt, 'vignette', S.VIGNETTE_FS, (p) => {
          p.f1('uAmount', n('amount') / 100);
          p.f1('uSize', n('size') / 100);
          p.f1('uSoftness', n('softness') / 100);
        });
      case 'grain':
        return this.simple(rt, 'grain', S.GRAIN_FS, (p) => {
          p.f1('uAmount', n('amount') / 100);
          p.f1('uSize', Math.max(1, n('size') * pxScale));
          p.f1('uTime', Math.floor(localTime * 24) / 24);
        });
      case 'glow': {
        const bright = this.pool.acquire(rt.w, rt.h);
        this.pass(this.prog('threshold', S.THRESHOLD_FS), rt.tex, bright, (p) => p.f1('uThreshold', n('threshold') / 100));
        const blurred = this.blur(bright, Math.max(1, n('radius') * 0.6 * pxScale));
        const out = this.pool.acquire(rt.w, rt.h);
        this.pass(this.prog('add', S.ADD_FS), rt.tex, out, (p) => {
          this.bindTex(1, blurred.tex);
          p.i1('uOther', 1);
          p.f1('uAmount', n('strength') / 100);
        });
        this.pool.release(blurred);
        this.pool.release(rt);
        return out;
      }
      case 'rgbSplit': {
        const d = n('amount') * 0.4 * pxScale;
        const a = (n('angle') * Math.PI) / 180;
        return this.simple(rt, 'rgbsplit', S.RGBSPLIT_FS, (p) => p.f2('uOffset', (Math.cos(a) * d) / rt.w, (Math.sin(a) * d) / rt.h));
      }
      case 'pixelate':
        return this.simple(rt, 'pixelate', S.PIXELATE_FS, (p) => p.f1('uSize', Math.max(1, n('size') * pxScale)));
      case 'posterize':
        return this.simple(rt, 'posterize', S.POSTERIZE_FS, (p) => p.f1('uLevels', Math.max(2, n('levels'))));
      case 'vhs':
        return this.simple(rt, 'vhs', S.VHS_FS, (p) => {
          p.f1('uAmount', n('amount') / 100);
          p.f1('uTime', localTime);
        });
      case 'border': {
        const [r, g, b] = hexToRgb(this.str(fx, 'color'));
        return this.simple(rt, 'border', S.BORDER_FS, (p) => {
          p.f1('uWidth', n('width') * pxScale);
          p.f3('uColor', r, g, b);
        });
      }
      case 'grayscale':
      case 'sepia':
      case 'invert':
      case 'tint':
      case 'duotone': {
        const kind = { grayscale: 0, sepia: 1, invert: 2, tint: 3, duotone: 4 }[fx.type]!;
        const ca = hexToRgb(fx.type === 'duotone' ? this.str(fx, 'dark') : fx.type === 'tint' ? this.str(fx, 'color') : '#000000');
        const cb = hexToRgb(fx.type === 'duotone' ? this.str(fx, 'light') : '#ffffff');
        return this.simple(rt, 'colorops', S.COLOROPS_FS, (p) => {
          p.i1('uKind', kind);
          p.f1('uAmount', n('amount') / 100);
          p.f3('uColorA', ca[0], ca[1], ca[2]);
          p.f3('uColorB', cb[0], cb[1], cb[2]);
        });
      }
      case 'mirror': {
        const mode = { horizontal: 0, vertical: 1, quad: 2 }[this.str(fx, 'mode')] ?? 0;
        return this.simple(rt, 'mirror', S.MIRROR_FS, (p) => p.i1('uMode', mode));
      }
      case 'wave':
        return this.simple(rt, 'wave', S.WAVE_FS, (p) => {
          p.f1('uAmount', n('amount') / 100);
          p.f1('uFreq', n('frequency'));
          p.f1('uTime', localTime * n('speed'));
        });
      case 'chromaKey': {
        const [r, g, b] = hexToRgb(this.str(fx, 'keyColor'));
        return this.simple(rt, 'chromakey', S.CHROMAKEY_FS, (p) => {
          p.f3('uKey', r, g, b);
          p.f1('uSimilarity', n('similarity') / 100);
          p.f1('uSmoothness', n('smoothness') / 100);
          p.f1('uSpill', n('spill') / 100);
        });
      }
      case 'lumaKey':
        return this.simple(rt, 'lumakey', S.LUMAKEY_FS, (p) => {
          p.f1('uThreshold', n('threshold') / 100);
          p.f1('uSoftness', n('softness') / 100);
          p.i1('uInvert', fx.params.invert ? 1 : 0);
        });
      default:
        return rt;
    }
  }

  /** Free GPU resources for clips that no longer exist. */
  forgetClip(clipId: string) {
    const e = this.videoTex.get(clipId);
    if (e) {
      this.gl.deleteTexture(e.tex);
      this.videoTex.delete(clipId);
    }
  }

  forgetImage(assetId: string) {
    const e = this.imageTex.get(assetId);
    if (e) {
      this.gl.deleteTexture(e.tex);
      this.imageTex.delete(assetId);
    }
  }

  /** Drop references to video samples (call before samples are closed elsewhere). */
  releaseVideoRefs() {
    for (const e of this.videoTex.values()) e.sample = null;
  }

  dispose() {
    const gl = this.gl;
    for (const e of this.videoTex.values()) gl.deleteTexture(e.tex);
    for (const e of this.imageTex.values()) gl.deleteTexture(e.tex);
    for (const e of this.rasters.values()) gl.deleteTexture(e.tex);
    for (const p of this.programs.values()) p.dispose();
    this.pool.dispose();
    this.videoTex.clear();
    this.imageTex.clear();
    this.rasters.clear();
    this.programs.clear();
  }

  /** Last frame's time (useful for consumers checking staleness). */
  get lastTime() {
    return this.time;
  }
}
