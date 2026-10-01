/** Minimal WebGL2 utilities: programs, render targets, a unit quad. */

export type GL = WebGL2RenderingContext;

export interface RenderTarget {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

export const VERT = /* glsl */ `#version 300 es
in vec2 aPos;
uniform mat3 uMatrix;
uniform mat3 uUVMatrix;
out vec2 vUV;
out vec2 vLocal;
void main() {
  vec3 p = uMatrix * vec3(aPos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vUV = (uUVMatrix * vec3(aPos, 1.0)).xy;
  vLocal = aPos;
}`;

export class Program {
  readonly prog: WebGLProgram;
  private locs = new Map<string, WebGLUniformLocation | null>();

  constructor(
    private readonly gl: GL,
    fragSrc: string,
    vertSrc = VERT,
  ) {
    const vs = compile(gl, gl.VERTEX_SHADER, vertSrc);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      throw new Error('Program link failed: ' + log);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.prog = prog;
  }

  use() {
    this.gl.useProgram(this.prog);
  }

  loc(name: string): WebGLUniformLocation | null {
    let l = this.locs.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.prog, name);
      this.locs.set(name, l);
    }
    return l;
  }

  f1(name: string, v: number) {
    this.gl.uniform1f(this.loc(name), v);
  }
  f2(name: string, a: number, b: number) {
    this.gl.uniform2f(this.loc(name), a, b);
  }
  f3(name: string, a: number, b: number, c: number) {
    this.gl.uniform3f(this.loc(name), a, b, c);
  }
  f4(name: string, a: number, b: number, c: number, d: number) {
    this.gl.uniform4f(this.loc(name), a, b, c, d);
  }
  i1(name: string, v: number) {
    this.gl.uniform1i(this.loc(name), v);
  }
  m3(name: string, m: Float32Array) {
    this.gl.uniformMatrix3fv(this.loc(name), false, m);
  }

  dispose() {
    this.gl.deleteProgram(this.prog);
  }
}

function compile(gl: GL, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('Shader compile failed: ' + log + '\n' + src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'));
  }
  return s;
}

export function createTexture(gl: GL, w: number, h: number): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  setSampling(gl, gl.LINEAR, gl.LINEAR);
  return tex;
}

export function setSampling(gl: GL, min: number, mag: number) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

/** Pool of RGBA8 render targets keyed by size; reused across frames. */
export class TargetPool {
  private free = new Map<string, RenderTarget[]>();
  private all: RenderTarget[] = [];

  constructor(private readonly gl: GL) {}

  acquire(w: number, h: number): RenderTarget {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    const key = `${w}x${h}`;
    const list = this.free.get(key);
    if (list && list.length) return list.pop()!;
    const gl = this.gl;
    const tex = createTexture(gl, w, h);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const rt = { tex, fbo, w, h };
    this.all.push(rt);
    return rt;
  }

  release(rt: RenderTarget | null | undefined) {
    if (!rt) return;
    const key = `${rt.w}x${rt.h}`;
    let list = this.free.get(key);
    if (!list) this.free.set(key, (list = []));
    if (!list.includes(rt)) list.push(rt);
  }

  /** Drop pooled targets that weren't used recently (call between frames when sizes change). */
  trim(maxFree = 6) {
    for (const [key, list] of this.free) {
      while (list.length > maxFree) {
        const rt = list.shift()!;
        this.gl.deleteTexture(rt.tex);
        this.gl.deleteFramebuffer(rt.fbo);
        this.all = this.all.filter((x) => x !== rt);
      }
      if (list.length === 0) this.free.delete(key);
    }
  }

  dispose() {
    for (const rt of this.all) {
      this.gl.deleteTexture(rt.tex);
      this.gl.deleteFramebuffer(rt.fbo);
    }
    this.all = [];
    this.free.clear();
  }
}

export function createQuad(gl: GL): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  return vao;
}

export const IDENTITY3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
/** Unit quad (0..1) -> full viewport clip space, y-down convention (row 0 = top). */
export const FULLSCREEN = new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]);

/** Parse "#rrggbb" / "#rgb" into linear-ish 0..1 sRGB components. */
export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Multiply two column-major 3x3 matrices: a * b. */
export function mul3(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(9);
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      o[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2];
    }
  }
  return o;
}

/** Affine (column-major) from x' = a*x + c*y + e, y' = b*x + d*y + f. */
export function affine(a: number, b: number, c: number, d: number, e: number, f: number): Float32Array {
  return new Float32Array([a, b, 0, c, d, 0, e, f, 1]);
}
