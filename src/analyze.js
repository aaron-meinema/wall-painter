'use strict';
/*
 * Photo analysis for the magic wand: Lab colour + edge strength.
 * Runs in a Web Worker so photos can be prepared in the background; also loaded as a normal
 * script so the app can fall back to the main thread if workers are unavailable.
 *
 * Output is compact (5 bytes per pixel) so every house photo can stay prepared in memory:
 *   lab  Uint8Array(N*3): L*2.55, a+128, b+128
 *   edge Uint8Array(N):   edge barrier ×2 (Sobel + coarse soft-corner edges, thickened by 2px)
 *   fine Uint8Array(N):   thin Sobel edges ×2 (used to grow a selection back up to real boundaries)
 */
(function () {
  const S2L = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  const q8 = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0);

  function analyzePixels(src, W, H) {
    const N = W * H;
    const lab = new Uint8Array(N * 3);
    const Lc = new Float32Array(N);
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      const r = S2L[src[j]], g = S2L[src[j + 1]], b = S2L[src[j + 2]];
      const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
      const fy = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
      const fz = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
      const L = 116 * fy - 16;
      lab[i * 3] = q8(L * 2.55); lab[i * 3 + 1] = q8(500 * (fx - fy) + 128); lab[i * 3 + 2] = q8(200 * (fy - fz) + 128);
      Lc[i] = L;
    }
    // 3×3 box blur of lightness to calm sensor noise, then Sobel.
    const tmp = new Float32Array(N), bl = new Float32Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; tmp[i] = (Lc[x > 0 ? i - 1 : i] + Lc[i] + Lc[x < W - 1 ? i + 1 : i]) / 3;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; bl[i] = (tmp[y > 0 ? i - W : i] + tmp[i] + tmp[y < H - 1 ? i + W : i]) / 3;
    }
    const edge = Lc; // reuse buffer
    edge.fill(0);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const a = bl[i - W - 1], b = bl[i - W], c = bl[i - W + 1], d = bl[i - 1], e = bl[i + 1], g = bl[i + W - 1], h = bl[i + W], k = bl[i + W + 1];
      const gx = c + 2 * e + k - a - 2 * d - g;
      const gy = g + 2 * h + k - a - 2 * b - c;
      edge[i] = Math.sqrt(gx * gx + gy * gy);
    }
    const fine = new Uint8Array(N);
    for (let i = 0; i < N; i++) fine[i] = q8(edge[i] * 2);

    // Coarse edges: lightness difference across ±3px on a wider blur. Catches soft, shaded corners
    // (wall meets ceiling in diffuse light) that a 3×3 Sobel barely sees.
    const CK = 3, D = 3;
    const b2 = tmp, b3 = new Float32Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0, c = 0; const row = y * W;
      for (let xx = Math.max(0, x - 2), xe = Math.min(W - 1, x + 2); xx <= xe; xx++) { s += bl[row + xx]; c++; }
      b2[row + x] = s / c;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0, c = 0;
      for (let yy = Math.max(0, y - 2), ye = Math.min(H - 1, y + 2); yy <= ye; yy++) { s += b2[yy * W + x]; c++; }
      b3[y * W + x] = s / c;
    }
    for (let y = D; y < H - D; y++) for (let x = D; x < W - D; x++) {
      const i = y * W + x;
      const gx = b3[i + D] - b3[i - D], gy = b3[i + D * W] - b3[i - D * W];
      const g = CK * Math.sqrt(gx * gx + gy * gy);
      if (g > edge[i]) edge[i] = g;
    }
    // Thicken the edge barrier (max filter, radius 2) so the wand can't slip through 1–3px gaps
    // in faint white-on-white corners (wall/ceiling, wall/trim).
    const R = 2, mx = bl, barrier = new Uint8Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let m = 0; const row = y * W;
      for (let xx = Math.max(0, x - R), xe = Math.min(W - 1, x + R); xx <= xe; xx++) if (edge[row + xx] > m) m = edge[row + xx];
      mx[row + x] = m;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let m = 0;
      for (let yy = Math.max(0, y - R), ye = Math.min(H - 1, y + R); yy <= ye; yy++) if (mx[yy * W + x] > m) m = mx[yy * W + x];
      barrier[y * W + x] = q8(m * 2);
    }
    return { lab, edge: barrier, fine };
  }

  if (typeof window === 'undefined') {
    self.onmessage = (e) => {
      const { id, W, H, buf } = e.data;
      const r = analyzePixels(new Uint8ClampedArray(buf), W, H);
      self.postMessage({ id, lab: r.lab.buffer, edge: r.edge.buffer, fine: r.fine.buffer }, [r.lab.buffer, r.edge.buffer, r.fine.buffer]);
    };
  } else {
    window.analyzePixels = analyzePixels;
  }
})();
