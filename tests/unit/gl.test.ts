import { describe, expect, it } from 'vitest';
import { TargetPool } from '../../src/engine/gl';

/** Just enough of WebGL2 for the pool: counts live textures. */
function mockGL() {
  let live = 0;
  const gl = new Proxy(
    {},
    {
      get: (_t, k) => {
        if (k === 'createTexture') return () => ({ id: ++live });
        if (k === 'deleteTexture') return () => void live--;
        if (k === 'createFramebuffer') return () => ({});
        if (typeof k === 'string' && /^[A-Z0-9_]+$/.test(k)) return 0; // enum constants
        return () => {};
      },
    },
  ) as unknown as WebGL2RenderingContext;
  return { gl, live: () => live };
}

const MB = 1024 * 1024;

describe('render target pool', () => {
  it('reuses one target per size in steady state', () => {
    const { gl, live } = mockGL();
    const pool = new TargetPool(gl);
    for (let f = 0; f < 500; f++) {
      pool.tick();
      const a = pool.acquire(1920, 1080);
      const b = pool.acquire(1920, 1080);
      pool.release(a);
      pool.release(b);
      if (f % 30 === 0) pool.trim();
    }
    expect(pool.stats().targets).toBe(2);
    expect(live()).toBe(2);
  });

  it('stays within budget when the size changes every frame, and frees idle sizes', () => {
    const { gl, live } = mockGL();
    const pool = new TargetPool(gl);
    // An animated zoom: the processed layer is a new size on every frame (~8 MB each).
    for (let f = 0; f < 600; f++) {
      pool.tick();
      const rt = pool.acquire(1920 + f, 1080 + f);
      pool.release(rt);
      if (f % 30 === 0) pool.trim();
      // Between trims (every 30 frames) at most 30 new targets can pile up on top of the budget.
      expect(pool.stats().bytes).toBeLessThanOrEqual(256 * MB + 31 * (1920 + f) * (1080 + f) * 4);
    }
    pool.trim();
    expect(pool.stats().bytes).toBeLessThanOrEqual(256 * MB);
    // Nothing used for a while: everything goes.
    for (let f = 0; f < 100; f++) pool.tick();
    pool.trim();
    expect(pool.stats().targets).toBe(0);
    expect(live()).toBe(0);
  });

  it('keeps targets that are in use', () => {
    const { gl } = mockGL();
    const pool = new TargetPool(gl);
    const held = pool.acquire(640, 360);
    for (let f = 0; f < 200; f++) pool.tick();
    pool.trim();
    expect(pool.stats().targets).toBe(1); // never released, so never freed
    pool.release(held);
    for (let f = 0; f < 100; f++) pool.tick();
    pool.trim();
    expect(pool.stats().targets).toBe(0);
  });
});
