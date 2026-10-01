/**
 * Fragment shaders. All textures hold premultiplied-alpha RGBA in sRGB space,
 * with texture row 0 = top of the image. Color operations unpremultiply,
 * process, and re-premultiply.
 */

const HEAD = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
in vec2 vLocal;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uTexSize;
vec3 unpremul(vec4 c) { return c.a > 0.0001 ? c.rgb / c.a : vec3(0.0); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
`;

export const COPY_FS = HEAD + /* glsl */ `
void main() { outColor = texture(uTex, vUV); }`;

/** Final placement of a layer with opacity, rounded corners, wipe mask and edge antialiasing. */
export const DRAW_FS = HEAD + /* glsl */ `
uniform float uOpacity;
uniform vec2 uSize;
uniform float uRadius;
uniform float uWipe;
void main() {
  vec4 c = texture(uTex, vUV);
  vec2 p = vLocal * uSize;
  vec2 d2 = min(p, uSize - p);
  float a = clamp(min(d2.x, d2.y) + 0.5, 0.0, 1.0);
  if (uRadius > 0.0) {
    vec2 q = abs(p - uSize * 0.5) - (uSize * 0.5 - vec2(uRadius));
    float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
    a *= clamp(0.5 - dist, 0.0, 1.0);
  }
  if (uWipe < 1.0) {
    float s = 0.04;
    a *= clamp((uWipe * (1.0 + s) - vLocal.x) / s, 0.0, 1.0);
  }
  outColor = c * (a * uOpacity);
}`;

/** Blend layer (uTex) over base (uBase) with a separable blend mode. */
export const BLEND_FS = HEAD + /* glsl */ `
uniform sampler2D uBase;
uniform int uMode;
vec3 blendFn(vec3 b, vec3 s) {
  if (uMode == 1) return b * s;
  if (uMode == 2) return b + s - b * s;
  if (uMode == 3) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (uMode == 4) return min(b, s);
  if (uMode == 5) return max(b, s);
  if (uMode == 6) return min(b + s, vec3(1.0));
  if (uMode == 7) return abs(b - s);
  if (uMode == 8) {
    vec3 d = mix(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, step(b, vec3(0.25)));
    return mix(b - (1.0 - 2.0 * s) * b * (1.0 - b), b + (2.0 * s - 1.0) * (d - b), step(0.5, s));
  }
  return s;
}
void main() {
  vec4 base = texture(uBase, vUV);
  vec4 src = texture(uTex, vUV);
  vec3 cb = unpremul(base);
  vec3 cs = unpremul(src);
  vec3 mixed = cs * (1.0 - base.a) + blendFn(cb, cs) * base.a;
  vec3 rgb = src.a * mixed + (1.0 - src.a) * base.rgb;
  float a = src.a + base.a * (1.0 - src.a);
  outColor = vec4(rgb, a);
}`;

/** Mix two textures by a factor (used by adjustment layer opacity). */
export const MIX_FS = HEAD + /* glsl */ `
uniform sampler2D uOther;
uniform float uAmount;
void main() { outColor = mix(texture(uTex, vUV), texture(uOther, vUV), uAmount); }`;

export const COLOR_FS = HEAD + /* glsl */ `
uniform float uExposure, uContrast, uSaturation, uVibrance, uTemp, uTint, uHighlights, uShadows, uHue;
vec3 hueRotate(vec3 c, float deg) {
  float a = radians(deg);
  float cosA = cos(a), sinA = sin(a);
  mat3 m = mat3(
    0.299 + 0.701 * cosA + 0.168 * sinA, 0.299 - 0.299 * cosA - 0.328 * sinA, 0.299 - 0.300 * cosA + 1.250 * sinA,
    0.587 - 0.587 * cosA + 0.330 * sinA, 0.587 + 0.413 * cosA + 0.035 * sinA, 0.587 - 0.588 * cosA - 1.050 * sinA,
    0.114 - 0.114 * cosA - 0.497 * sinA, 0.114 - 0.114 * cosA + 0.292 * sinA, 0.114 + 0.886 * cosA - 0.203 * sinA);
  return m * c;
}
void main() {
  vec4 src = texture(uTex, vUV);
  if (src.a < 0.0001) { outColor = src; return; }
  vec3 c = src.rgb / src.a;
  c *= exp2(uExposure);
  c *= vec3(1.0 + uTemp * 0.18 + uTint * 0.06, 1.0 - uTint * 0.14, 1.0 - uTemp * 0.18 + uTint * 0.06);
  float l = luma(c);
  float sh = uShadows * (1.0 - smoothstep(0.0, 0.55, l)) * 0.45;
  float hi = uHighlights * smoothstep(0.45, 1.0, l) * 0.45;
  c += vec3(sh + hi);
  c = (c - 0.5) * (1.0 + uContrast) + 0.5;
  if (abs(uHue) > 0.01) c = hueRotate(c, uHue);
  l = luma(c);
  float sat = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
  float vib = uVibrance * (1.0 - sat);
  c = mix(vec3(l), c, 1.0 + uSaturation + vib);
  c = clamp(c, 0.0, 1.0);
  outColor = vec4(c * src.a, src.a);
}`;

/** Separable gaussian blur. uDir is a texel-space step vector. */
export const BLUR_FS = HEAD + /* glsl */ `
uniform vec2 uDir;
uniform float uSigma;
void main() {
  if (uSigma < 0.3) { outColor = texture(uTex, vUV); return; }
  float radius = ceil(uSigma * 3.0);
  float stepPx = max(1.0, radius / 24.0);
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -24; i <= 24; i++) {
    float x = float(i) * stepPx;
    if (abs(x) > radius) continue;
    float w = exp(-0.5 * x * x / (uSigma * uSigma));
    acc += texture(uTex, vUV + uDir * x) * w;
    wsum += w;
  }
  outColor = acc / wsum;
}`;

export const DIRBLUR_FS = HEAD + /* glsl */ `
uniform vec2 uDir; // full blur vector in uv units
void main() {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 32; i++) {
    float t = float(i) / 31.0 - 0.5;
    acc += texture(uTex, vUV + uDir * t);
  }
  outColor = acc / 32.0;
}`;

export const ZOOMBLUR_FS = HEAD + /* glsl */ `
uniform float uAmount;
void main() {
  vec4 acc = vec4(0.0);
  vec2 d = vUV - 0.5;
  for (int i = 0; i < 32; i++) {
    float s = 1.0 - uAmount * float(i) / 31.0;
    acc += texture(uTex, 0.5 + d * s);
  }
  outColor = acc / 32.0;
}`;

export const SHARPEN_FS = HEAD + /* glsl */ `
uniform float uAmount;
void main() {
  vec2 px = 1.0 / uTexSize;
  vec4 c = texture(uTex, vUV);
  vec4 b = (texture(uTex, vUV + vec2(px.x, 0.0)) + texture(uTex, vUV - vec2(px.x, 0.0)) +
            texture(uTex, vUV + vec2(0.0, px.y)) + texture(uTex, vUV - vec2(0.0, px.y))) * 0.25;
  vec4 o = c + (c - b) * uAmount * 2.0;
  o.a = c.a;
  o.rgb = clamp(o.rgb, 0.0, o.a);
  outColor = o;
}`;

export const VIGNETTE_FS = HEAD + /* glsl */ `
uniform float uAmount, uSize, uSoftness;
void main() {
  vec4 c = texture(uTex, vUV);
  vec2 d = (vUV - 0.5) * vec2(uTexSize.x / max(uTexSize.x, uTexSize.y), uTexSize.y / max(uTexSize.x, uTexSize.y)) * 2.0;
  float r = length(d);
  float inner = mix(0.2, 1.2, uSize);
  float v = smoothstep(inner, inner + mix(0.05, 1.2, uSoftness), r);
  vec3 rgb = unpremul(c);
  if (uAmount >= 0.0) rgb *= 1.0 - v * uAmount;
  else rgb = mix(rgb, vec3(1.0), v * -uAmount);
  outColor = vec4(rgb * c.a, c.a);
}`;

export const GRAIN_FS = HEAD + /* glsl */ `
uniform float uAmount, uSize, uTime;
void main() {
  vec4 c = texture(uTex, vUV);
  vec2 p = floor(vUV * uTexSize / uSize);
  float n = hash(p + fract(uTime * 13.37) * 100.0) - 0.5;
  vec3 rgb = unpremul(c);
  float l = luma(rgb);
  rgb += n * uAmount * 0.35 * (1.0 - abs(l - 0.5));
  outColor = vec4(clamp(rgb, 0.0, 1.0) * c.a, c.a);
}`;

export const THRESHOLD_FS = HEAD + /* glsl */ `
uniform float uThreshold;
void main() {
  vec4 c = texture(uTex, vUV);
  vec3 rgb = unpremul(c);
  float l = luma(rgb);
  float k = smoothstep(uThreshold, uThreshold + 0.15, l);
  outColor = vec4(rgb * k * c.a, c.a * k);
}`;

export const ADD_FS = HEAD + /* glsl */ `
uniform sampler2D uOther;
uniform float uAmount;
void main() {
  vec4 a = texture(uTex, vUV);
  vec4 b = texture(uOther, vUV) * uAmount;
  vec3 rgb = a.rgb + b.rgb;
  float alpha = max(a.a, min(1.0, b.a));
  outColor = vec4(min(rgb, vec3(alpha)), alpha);
}`;

export const RGBSPLIT_FS = HEAD + /* glsl */ `
uniform vec2 uOffset;
void main() {
  vec4 r = texture(uTex, vUV + uOffset);
  vec4 g = texture(uTex, vUV);
  vec4 b = texture(uTex, vUV - uOffset);
  float a = max(g.a, max(r.a, b.a));
  outColor = vec4(r.r, g.g, b.b, a);
}`;

export const PIXELATE_FS = HEAD + /* glsl */ `
uniform float uSize;
void main() {
  vec2 cell = uSize / uTexSize;
  vec2 uv = (floor(vUV / cell) + 0.5) * cell;
  outColor = texture(uTex, uv);
}`;

export const POSTERIZE_FS = HEAD + /* glsl */ `
uniform float uLevels;
void main() {
  vec4 c = texture(uTex, vUV);
  vec3 rgb = floor(unpremul(c) * (uLevels - 1.0) + 0.5) / (uLevels - 1.0);
  outColor = vec4(rgb * c.a, c.a);
}`;

export const VHS_FS = HEAD + /* glsl */ `
uniform float uAmount, uTime;
void main() {
  vec2 uv = vUV;
  float line = floor(uv.y * uTexSize.y / 2.0);
  float jitter = (hash(vec2(line, floor(uTime * 24.0))) - 0.5) * 0.004 * uAmount;
  uv.x += jitter;
  float shift = 0.004 * uAmount;
  vec4 c = texture(uTex, uv);
  float r = texture(uTex, uv + vec2(shift, 0.0)).r;
  float b = texture(uTex, uv - vec2(shift, 0.0)).b;
  vec3 rgb = vec3(r, c.g, b);
  rgb = c.a > 0.0001 ? rgb / c.a : rgb;
  float scan = 0.5 + 0.5 * sin(uv.y * uTexSize.y * 3.14159);
  rgb *= 1.0 - uAmount * 0.18 * scan;
  rgb = mix(rgb, vec3(luma(rgb)), 0.25 * uAmount);
  rgb += (hash(uv * uTexSize + uTime) - 0.5) * 0.08 * uAmount;
  outColor = vec4(clamp(rgb, 0.0, 1.0) * c.a, c.a);
}`;

export const BORDER_FS = HEAD + /* glsl */ `
uniform float uWidth;
uniform vec3 uColor;
void main() {
  vec4 c = texture(uTex, vUV);
  vec2 p = vUV * uTexSize;
  vec2 d2 = min(p, uTexSize - p);
  float d = min(d2.x, d2.y);
  float k = 1.0 - clamp(d - uWidth + 0.5, 0.0, 1.0);
  outColor = mix(c, vec4(uColor, 1.0) * max(c.a, 1.0), k * step(0.001, uWidth));
}`;

/** Grayscale / sepia / invert / tint / duotone share one shader (uKind selects). */
export const COLOROPS_FS = HEAD + /* glsl */ `
uniform int uKind;
uniform float uAmount;
uniform vec3 uColorA;
uniform vec3 uColorB;
void main() {
  vec4 c = texture(uTex, vUV);
  vec3 rgb = unpremul(c);
  vec3 o = rgb;
  float l = luma(rgb);
  if (uKind == 0) o = vec3(l);
  else if (uKind == 1) o = vec3(dot(rgb, vec3(0.393, 0.769, 0.189)), dot(rgb, vec3(0.349, 0.686, 0.168)), dot(rgb, vec3(0.272, 0.534, 0.131)));
  else if (uKind == 2) o = 1.0 - rgb;
  else if (uKind == 3) o = mix(rgb, uColorA * (0.4 + l * 0.8), 1.0);
  else if (uKind == 4) o = mix(uColorA, uColorB, smoothstep(0.0, 1.0, l));
  rgb = mix(rgb, clamp(o, 0.0, 1.0), uAmount);
  outColor = vec4(rgb * c.a, c.a);
}`;

export const MIRROR_FS = HEAD + /* glsl */ `
uniform int uMode;
void main() {
  vec2 uv = vUV;
  if (uMode == 0 || uMode == 2) uv.x = uv.x > 0.5 ? 1.0 - uv.x : uv.x;
  if (uMode == 1 || uMode == 2) uv.y = uv.y > 0.5 ? 1.0 - uv.y : uv.y;
  outColor = texture(uTex, uv);
}`;

export const WAVE_FS = HEAD + /* glsl */ `
uniform float uAmount, uFreq, uTime;
void main() {
  vec2 uv = vUV;
  uv.x += sin(uv.y * uFreq * 6.2831 + uTime * 6.0) * uAmount * 0.02;
  uv.y += cos(uv.x * uFreq * 6.2831 + uTime * 4.0) * uAmount * 0.01;
  outColor = texture(uTex, uv);
}`;

export const CHROMAKEY_FS = HEAD + /* glsl */ `
uniform vec3 uKey;
uniform float uSimilarity, uSmoothness, uSpill;
vec2 rgbToUV(vec3 c) {
  return vec2(-0.169 * c.r - 0.331 * c.g + 0.5 * c.b, 0.5 * c.r - 0.419 * c.g - 0.081 * c.b);
}
void main() {
  vec4 src = texture(uTex, vUV);
  vec3 rgb = unpremul(src);
  float d = distance(rgbToUV(rgb), rgbToUV(uKey));
  float sim = uSimilarity * 0.6;
  float a = smoothstep(sim, sim + max(0.001, uSmoothness * 0.4), d);
  // Spill suppression: pull the key channel toward the other two.
  float spill = clamp(pow(clamp((d - sim) / max(0.0001, uSpill * 0.6), 0.0, 1.0), 1.5), 0.0, 1.0);
  float desat = luma(rgb);
  rgb = mix(vec3(desat), rgb, spill * 0.7 + 0.3);
  float alpha = src.a * a;
  outColor = vec4(rgb * alpha, alpha);
}`;

export const LUMAKEY_FS = HEAD + /* glsl */ `
uniform float uThreshold, uSoftness;
uniform int uInvert;
void main() {
  vec4 src = texture(uTex, vUV);
  float l = luma(unpremul(src));
  if (uInvert == 1) l = 1.0 - l;
  float a = smoothstep(uThreshold, uThreshold + max(0.001, uSoftness), l);
  outColor = src * a;
}`;

/* --------------------------------- Transitions -------------------------------- */

const TRANS_HEAD = HEAD + /* glsl */ `
uniform sampler2D uB;
uniform float uP;
uniform vec2 uRes;
vec4 A(vec2 uv) { return (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? vec4(0.0) : texture(uTex, uv); }
vec4 B(vec2 uv) { return (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? vec4(0.0) : texture(uB, uv); }
float ease(float t) { return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0; }
`;

function transition(body: string): string {
  return TRANS_HEAD + `\nvoid main() {\n  vec2 uv = vUV;\n  float p = uP;\n${body}\n}`;
}

export const TRANSITION_FS: Record<string, string> = {
  crossfade: transition(`outColor = mix(A(uv), B(uv), p);`),
  dipBlack: transition(`
    vec4 a = A(uv), b = B(uv);
    vec4 k = vec4(0.0, 0.0, 0.0, max(a.a, b.a));
    outColor = p < 0.5 ? mix(a, k, smoothstep(0.0, 1.0, p * 2.0)) : mix(k, b, smoothstep(0.0, 1.0, p * 2.0 - 1.0));`),
  dipWhite: transition(`
    vec4 a = A(uv), b = B(uv);
    float al = max(a.a, b.a);
    vec4 k = vec4(al);
    outColor = p < 0.5 ? mix(a, k, smoothstep(0.0, 1.0, p * 2.0)) : mix(k, b, smoothstep(0.0, 1.0, p * 2.0 - 1.0));`),
  wipeLeft: transition(`
    float s = 0.08; float e = ease(p) * (1.0 + s);
    float m = smoothstep(1.0 - e, 1.0 - e + s, uv.x);
    outColor = mix(A(uv), B(uv), m);`),
  wipeRight: transition(`
    float s = 0.08; float e = ease(p) * (1.0 + s);
    float m = 1.0 - smoothstep(e - s, e, uv.x);
    outColor = mix(A(uv), B(uv), m);`),
  wipeUp: transition(`
    float s = 0.08; float e = ease(p) * (1.0 + s);
    float m = smoothstep(1.0 - e, 1.0 - e + s, uv.y);
    outColor = mix(A(uv), B(uv), m);`),
  wipeDown: transition(`
    float s = 0.08; float e = ease(p) * (1.0 + s);
    float m = 1.0 - smoothstep(e - s, e, uv.y);
    outColor = mix(A(uv), B(uv), m);`),
  slideLeft: transition(`
    float e = ease(p);
    vec4 a = A(uv + vec2(e, 0.0));
    vec4 b = B(uv - vec2(1.0 - e, 0.0));
    outColor = b + a * (1.0 - b.a);`),
  slideRight: transition(`
    float e = ease(p);
    vec4 a = A(uv - vec2(e, 0.0));
    vec4 b = B(uv + vec2(1.0 - e, 0.0));
    outColor = b + a * (1.0 - b.a);`),
  slideUp: transition(`
    float e = ease(p);
    vec4 a = A(uv + vec2(0.0, e));
    vec4 b = B(uv - vec2(0.0, 1.0 - e));
    outColor = b + a * (1.0 - b.a);`),
  slideDown: transition(`
    float e = ease(p);
    vec4 a = A(uv - vec2(0.0, e));
    vec4 b = B(uv + vec2(0.0, 1.0 - e));
    outColor = b + a * (1.0 - b.a);`),
  zoom: transition(`
    float e = ease(p);
    vec2 c = uv - 0.5;
    vec4 a = A(0.5 + c / (1.0 + e * 1.5));
    vec4 b = B(0.5 + c / (0.5 + 0.5 * e));
    outColor = mix(a, b, smoothstep(0.3, 0.7, p));`),
  iris: transition(`
    float e = ease(p);
    vec2 d = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
    float maxR = length(vec2(uRes.x / uRes.y, 1.0)) * 0.5;
    float r = e * (maxR + 0.05);
    float m = 1.0 - smoothstep(r - 0.02, r, length(d));
    outColor = mix(A(uv), B(uv), m);`),
  clock: transition(`
    vec2 d = uv - 0.5;
    float ang = atan(d.x, -d.y);
    float t = (ang + 3.14159265) / 6.2831853;
    float e = ease(p);
    float m = 1.0 - smoothstep(e - 0.01, e + 0.01, fract(t + 0.5));
    outColor = mix(A(uv), B(uv), m);`),
  blur: transition(`
    float r = sin(p * 3.14159) * 0.03;
    vec4 a = vec4(0.0), b = vec4(0.0);
    for (int i = 0; i < 16; i++) {
      float ang = float(i) * 2.399963;
      float rad = sqrt(float(i) / 16.0) * r;
      vec2 o = vec2(cos(ang), sin(ang)) * rad * vec2(uRes.y / uRes.x, 1.0);
      a += A(uv + o);
      b += B(uv + o);
    }
    outColor = mix(a / 16.0, b / 16.0, smoothstep(0.25, 0.75, p));`),
  pixelize: transition(`
    float s = max(1.0, sin(p * 3.14159) * 60.0);
    vec2 cell = s / uRes;
    vec2 q = s > 1.5 ? (floor(uv / cell) + 0.5) * cell : uv;
    outColor = mix(A(q), B(q), step(0.5, p));`),
  glitch: transition(`
    float k = sin(p * 3.14159);
    float band = floor(uv.y * 24.0);
    float off = (hash(vec2(band, floor(p * 20.0))) - 0.5) * 0.2 * k;
    vec2 q = vec2(uv.x + off, uv.y);
    vec4 src = p < 0.5 ? A(q) : B(q);
    vec4 srcR = p < 0.5 ? A(q + vec2(0.02 * k, 0.0)) : B(q + vec2(0.02 * k, 0.0));
    vec4 srcB = p < 0.5 ? A(q - vec2(0.02 * k, 0.0)) : B(q - vec2(0.02 * k, 0.0));
    outColor = vec4(srcR.r, src.g, srcB.b, src.a);`),
  spin: transition(`
    float e = ease(p);
    vec2 asp = vec2(uRes.x / uRes.y, 1.0);
    vec2 c = (uv - 0.5) * asp;
    // Spin while zooming in, so the frame stays covered through the turn.
    float angA = e * 3.14159;
    float angB = (e - 1.0) * 3.14159;
    mat2 ra = mat2(cos(angA), -sin(angA), sin(angA), cos(angA));
    mat2 rb = mat2(cos(angB), -sin(angB), sin(angB), cos(angB));
    float zA = 1.0 + e * 3.0;
    float zB = 1.0 + (1.0 - e) * 3.0;
    vec4 a = A(0.5 + (ra * c) / asp / zA);
    vec4 b = B(0.5 + (rb * c) / asp / zB);
    outColor = mix(a, b, smoothstep(0.4, 0.6, p));`),
};
