'use strict';
/*
 * Wall Painter — recolour walls in room photos.
 *
 * How the paint looks real: every selected pixel is recoloured as
 *     out = paint × (pixel / wallReference)
 * per channel, in linear light. `wallReference` is the wall's current colour: either picked by hand
 * ("This wall is painted now", default white), or — with "Match photo" on — measured from the selected
 * pixels themselves. Measured, the well-lit part of the wall comes out as exactly the new paint whatever
 * colour it had before, so differently painted walls end up the same colour; shadows and light falloff
 * within the wall are still carried over.
 *
 * Measured walls ("Other colour" / Match photo) are first turned into a white wall: only the brightness of each
 * pixel (shades of grey) is kept, relative to the wall's well-lit brightness, so none of the old colour leaks
 * into the new paint:
 *     out = paint × shading^g,   shading = Y(pixel) / Y(wallReference)
 * The wall's "Light" slider sets g: lighter lifts the shadows, darker deepens them; the well-lit part stays the paint.
 */
(() => {
  // ───────────────────────── Tauri bridge (with browser fallback) ─────────────────────────
  const T = window.__TAURI__;
  const isTauri = !!(T && T.core && T.core.invoke);
  const invoke = isTauri ? T.core.invoke : null;

  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const basename = (p) => String(p).split(/[\\/]/).pop();
  const dirname = (p) => { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i > 0 ? p.slice(0, i) : p; };
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  // ───────────────────────── platform ─────────────────────────
  // macOS keeps its own keys and glyphs (⌘ ⌥ ⇧). On Windows and Linux the same shortcuts use Ctrl / Alt / Shift,
  // so every label that names a key goes through keys().
  const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
  const keys = (s) => isMac ? s : String(s)
    .replace(/⇧⌘Z/g, 'Ctrl+Shift+Z or Ctrl+Y')
    .replace(/⌘-/g, 'Ctrl-').replace(/⌘/g, 'Ctrl+')
    .replace(/⌥ \+/g, 'Alt +').replace(/⌥-/g, 'Alt-').replace(/⌥/g, 'Alt');

  // ───────────────────────── colour maths ─────────────────────────
  const S2L = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  const LUT_N = 16384;
  const L2S = new Uint8ClampedArray(LUT_N + 1);
  for (let i = 0; i <= LUT_N; i++) { const v = i / LUT_N; L2S[i] = Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255); }
  const toS = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : L2S[(v * LUT_N + 0.5) | 0]);

  const validHex = (h) => /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(h.trim());
  function normHex(h) { h = h.trim().replace('#', '').toLowerCase(); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); return '#' + h; }
  function hexToRgb(h) { const n = parseInt(normHex(h).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

  const PALETTE = [
    ['Chalk White', '#F2EFE6'], ['Linen', '#E9E0D0'], ['Bone', '#DCD3C2'], ['Warm Greige', '#CFC5B4'], ['Mushroom', '#B5A898'], ['Stone Grey', '#9C9890'],
    ['Butter', '#EADBA8'], ['Ochre', '#C99A4A'], ['Clay Pink', '#D9AFA0'], ['Terracotta', '#C0745A'], ['Rust', '#9A4F38'], ['Plum', '#6E4E5C'],
    ['Sage', '#A7B39A'], ['Eucalyptus', '#7F9483'], ['Olive Grove', '#6B6F4E'], ['Forest', '#3F5546'], ['Lavender Grey', '#B7B2C2'], ['Dusk Mauve', '#8E7F8E'],
    ['Mist Blue', '#B9C8CF'], ['Sky Wash', '#9FB6C3'], ['Denim', '#5B7083'], ['Deep Navy', '#2F3A4A'], ['Charcoal', '#4A4A48'], ['Ink', '#26282B'],
  ];
  // What the wall is painted now (its real colour, not how it looks in the photo).
  const WALL_NOW = [['White', '#F2F0EB'], ['Off-white', '#E8E2D6'], ['Light grey', '#D3D1CC'], ['Greige', '#C9BFB3'], ['Taupe', '#B3A79A'], ['Grey', '#9E9C98']];
  const NEW_LAYER_COLORS = ['#A7B39A', '#B9C8CF', '#C0745A', '#E9E0D0', '#5B7083', '#D9AFA0', '#6B6F4E'];
  const paletteName = (hex) => (PALETTE.find((p) => p[1].toLowerCase() === hex.toLowerCase()) || [''])[0];

  // ───────────────────────── state ─────────────────────────
  const settings = loadSettings();
  const st = {
    W: 0, H: 0, N: 0,
    path: null, name: '', key: null,
    src: null, lab: null, edge: null, out: null, vis: null,
    layers: [], active: 0, uid: 0,
    tool: 'wand', mode: 'add',
    tol: settings.tol ?? 14, edgeStop: settings.edgeStop ?? 8, size: settings.size ?? 40, feather: settings.feather ?? 1,
    recent: settings.recent ?? [],
    view: { s: 1, x: 0, y: 0 },
    overlay: true,
    undo: [], redo: [],
    docs: new Map(), dirty: false,
    files: [],
    folder: null, project: null, gen: 0,
    poly: null, hover: null, drag: null,
    spaceDown: false, altDown: false,
    renderQueued: false, visQueued: false,
  };

  function loadSettings() { try { return JSON.parse(localStorage.getItem('wp:settings') || '{}'); } catch { return {}; } }
  function saveSettings() {
    try { localStorage.setItem('wp:settings', JSON.stringify({ tol: st.tol, edgeStop: st.edgeStop, size: st.size, feather: st.feather, recent: st.recent })); } catch { /* ignore */ }
  }

  // ───────────────────────── DOM ─────────────────────────
  const stage = $('stage'), world = $('world');
  const cvC = $('cv-composite'), cvO = $('cv-orig'), cvM = $('cv-mask'), cvU = $('cv-ui');
  const ctxC = cvC.getContext('2d');
  const ctxO = cvO.getContext('2d', { willReadFrequently: true });
  const ctxM = cvM.getContext('2d');
  const ctxU = cvU.getContext('2d');
  let scratch = null, scratchCtx = null;
  function getScratch() {
    if (!scratch) { scratch = document.createElement('canvas'); scratchCtx = scratch.getContext('2d', { willReadFrequently: true }); }
    if (scratch.width !== st.W || scratch.height !== st.H) { scratch.width = st.W; scratch.height = st.H; }
    return scratchCtx;
  }

  let toastTimer = null;
  function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms); }
  function busy(on, msg = 'Working…') { const b = $('busy'); b.textContent = msg; b.classList.toggle('hidden', !on); }

  // ───────────────────────── photo cache + background preparation ─────────────────────────
  // Every photo is decoded once and analysed for the wand in a background worker, then kept in memory
  // (≈28 MB per photo), so switching photos is instant.
  const cache = new Map(); // path -> { W, H, src, lab, edge, fine, loaded: Promise, ready: Promise, saved: Promise<json|null> }
  let worker = null, workerOK = false, jobId = 0;
  const jobs = new Map();
  function getWorker() {
    if (worker === null) {
      try {
        worker = new Worker('analyze.js');
        worker.onmessage = (e) => {
          workerOK = true;
          const j = jobs.get(e.data.id); if (!j) return; jobs.delete(e.data.id);
          j.resolve({ lab: new Uint8Array(e.data.lab), edge: new Uint8Array(e.data.edge), fine: new Uint8Array(e.data.fine) });
        };
        worker.onerror = (e) => {
          console.warn('Analysis worker failed, using main thread', e); if (e.preventDefault) e.preventDefault();
          worker = false; setInfo();
          for (const [id, j] of jobs) { jobs.delete(id); j.resolve(window.analyzePixels(j.src, j.W, j.H)); }
        };
      } catch { worker = false; }
    }
    return worker;
  }
  function analyzeAsync(src, W, H) {
    return new Promise((resolve) => {
      const w = getWorker();
      if (!w) { setTimeout(() => resolve(window.analyzePixels(src, W, H)), 0); return; }
      const id = ++jobId, copy = src.slice();
      jobs.set(id, { resolve, src, W, H });
      w.postMessage({ id, W, H, buf: copy.buffer }, [copy.buffer]);
    });
  }
  function prepare(path) {
    const hit = cache.get(path); if (hit) return hit.loaded;
    const e = {}; cache.set(path, e);
    e.loaded = (async () => {
      const bmp = await createImageBitmap(await readImageBlob(path));
      const k = Math.min(1, 4096 / Math.max(bmp.width, bmp.height));
      const W = Math.round(bmp.width * k), H = Math.round(bmp.height * k);
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(bmp, 0, 0, W, H);
      e.W = W; e.H = H; e.src = cx.getImageData(0, 0, W, H).data;
      c.width = c.height = 0;
      drawThumb(path, bmp);
      if (bmp.close) bmp.close();
      e.saved = savedFor(path);
      e.path = path;
      return e;
    })();
    e.loaded.catch(() => cache.delete(path));
    return e.loaded;
  }
  // Wand analysis for a photo: in the background worker, or (if workers don't run) on demand.
  function ensureAnalysis(e) {
    if (!e.ready) {
      e.ready = analyzeAsync(e.src, e.W, e.H).then((r) => {
        Object.assign(e, r);
        if (st.path === e.path) { st.lab = r.lab; st.edge = r.edge; st.fine = r.fine; }
        return e;
      });
    }
    return e.ready;
  }
  function setInfo() {
    const el = $('status-info'); if (!el) return;
    el.textContent = [st.preloadMsg, st.lastOpen, worker === false ? 'no background worker' : ''].filter(Boolean).join('  ·  ');
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }

  // Opening is queued: if you click through photos quickly, only the last one is actually shown.
  let wanted = null, openChain = Promise.resolve();
  function openPath(path) {
    wanted = path;
    markActiveThumb(path);
    const gen = st.gen;
    openChain = openChain.then(async () => {
      if (wanted !== path || st.path === path || gen !== st.gen) return;
      const quick = cache.get(path) && cache.get(path).src;
      if (!quick) { busy(true, 'Opening…'); await nextFrame(); }
      try {
        const t0 = performance.now();
        const e = await prepare(path);
        if (wanted !== path || gen !== st.gen) return;
        const t1 = performance.now();
        await showPhoto(path, e);
        const t2 = performance.now();
        await nextFrame();
        st.lastOpen = `opened in ${Math.round(performance.now() - t0)} ms (load ${Math.round(t1 - t0)}, show ${Math.round(t2 - t1)})`;
        console.log('[wall-painter]', basename(path), st.lastOpen);
        setInfo();
        try { localStorage.setItem('wp:last:' + st.folder, basename(path)); } catch { /* ignore */ }
      } catch (err) { console.error(err); toast('Could not open: ' + err); }
      finally { busy(false); }
    });
    return openChain;
  }

  async function showPhoto(path, e) {
    stashCurrentDoc(); releasePickers();
    const { W, H } = e;
    st.W = W; st.H = H; st.N = W * H;
    for (const c of [cvC, cvO, cvM]) { if (c.width !== W) c.width = W; if (c.height !== H) c.height = H; }
    world.style.width = W + 'px'; world.style.height = H + 'px';
    ctxO.putImageData(new ImageData(e.src, W, H), 0, 0);
    st.src = e.src;
    st.lab = e.lab || null; st.edge = e.edge || null; st.fine = e.fine || null;
    if (!st.out || st.out.width !== W || st.out.height !== H) { st.out = ctxC.createImageData(W, H); st.vis = ctxM.createImageData(W, H); }
    st.path = path; st.name = basename(path); st.key = st.name;
    if (getWorker()) ensureAnalysis(e);
    st.poly = null; st.drag = null;

    const mem = st.docs.get(path);
    if (mem) {
      st.layers = mem.layers; st.active = mem.active; st.undo = mem.undo; st.redo = mem.redo;
      if (mem.feather !== st.feather) for (const l of st.layers) updateSoftAll(l);
    } else {
      st.layers = []; st.undo = []; st.redo = []; st.active = 0;
      const saved = await e.saved;
      const ok = await restoreSession(saved && saved.data);
      if (!ok) st.layers.push(newLayer('Wall A', NEW_LAYER_COLORS[0]));
      st.dirty = false;
      // Work from before projects existed is copied into this folder's project file.
      if (ok && saved.legacy) { e.saved = Promise.resolve({ data: saved.data }); markDirty(); }
    }
    if (mem) st.dirty = false;

    $('empty').classList.add('hidden');
    $('photo-name').textContent = `${basename(st.folder)}  /  ${st.name}  ·  ${W}×${H}`;
    fit();
    renderAll();
    renderLayers(); syncColorPanel(); updateUndoButtons(); setStatus();
  }

  // Prepare all other photos in the background, nearest to the current one first.
  async function preloadAll() {
    const gen = st.gen;
    const cur = Math.max(0, st.files.indexOf(st.path));
    const order = st.files.map((p, i) => [p, Math.min(Math.abs(i - cur), st.files.length - Math.abs(i - cur))]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
    let done = 0;
    for (const p of order) {
      if (gen !== st.gen) return;
      try { const e = await prepare(p); if (getWorker()) await ensureAnalysis(e); } catch { /* skip */ }
      done++; st.preloadMsg = done < order.length ? `preparing photos ${done}/${order.length}` : ''; setInfo();
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  // ───────────────────────── layers ─────────────────────────
  function newLayer(name, color) {
    return { id: ++st.uid, name, color, op: 1, bright: 0, visible: true, mask: new Uint8Array(st.N), soft: new Uint8Array(st.N), orig: WALL_NOW[0][1], origAuto: false, light: 0, count: 0 };
  }
  const activeLayer = () => st.layers[st.active];
  function nextWallName() {
    const used = new Set(st.layers.map((l) => l.name));
    for (let i = 0; i < 26; i++) { const n = 'Wall ' + String.fromCharCode(65 + i); if (!used.has(n)) return n; }
    return 'Wall ' + (st.layers.length + 1);
  }
  const layerById = (id) => st.layers.find((l) => l.id === id);

  // Soft (feathered) mask over a rect, with box blur of radius = feather.
  function updateSoft(l, x0, y0, x1, y1) {
    const { W, H } = st, r = st.feather | 0, m = l.mask, s = l.soft;
    x0 = Math.max(0, x0 - r); y0 = Math.max(0, y0 - r); x1 = Math.min(W, x1 + r); y1 = Math.min(H, y1 + r);
    if (x1 <= x0 || y1 <= y0) return [0, 0, 0, 0];
    if (r === 0) { for (let y = y0; y < y1; y++) s.set(m.subarray(y * W + x0, y * W + x1), y * W + x0); return [x0, y0, x1, y1]; }
    const ry0 = Math.max(0, y0 - r), ry1 = Math.min(H, y1 + r), w = x1 - x0;
    const tmp = new Float32Array(w * (ry1 - ry0));
    for (let y = ry0; y < ry1; y++) {
      const row = y * W, trow = (y - ry0) * w;
      for (let x = x0; x < x1; x++) {
        let sum = 0, cnt = 0;
        const a = Math.max(0, x - r), b = Math.min(W - 1, x + r);
        for (let xx = a; xx <= b; xx++) { sum += m[row + xx]; cnt++; }
        tmp[trow + x - x0] = sum / cnt;
      }
    }
    for (let y = y0; y < y1; y++) {
      const a = Math.max(ry0, y - r), b = Math.min(ry1 - 1, y + r), cnt = b - a + 1;
      for (let x = x0; x < x1; x++) {
        let sum = 0;
        for (let yy = a; yy <= b; yy++) sum += tmp[(yy - ry0) * w + x - x0];
        s[y * W + x] = (sum / cnt + 0.5) | 0;
      }
    }
    return [x0, y0, x1, y1];
  }
  const updateSoftAll = (l) => updateSoft(l, 0, 0, st.W, st.H);

  // Counts the selected pixels and, for a wall on "Match photo", re-measures its current colour.
  // Returns true when that colour changed (the whole wall then needs a re-render).
  function updateRef(l) {
    const m = l.mask; let nz = 0;
    for (let i = 0, n = m.length; i < n; i++) if (m[i]) nz++;
    l.count = nz;
    if (!l.origAuto || !nz) return false;
    const hex = sampleWall(l);
    if (!hex || hex === l.orig) return false;
    l.orig = hex;
    if (l === activeLayer()) syncColorPanel();
    return true;
  }

  // What the selected wall looks like in the photo where it's well lit: the mean colour (linear light) of the
  // selected pixels between the 40th and 95th brightness percentile. That skips shadowed corners and dark
  // spots (sockets, frames that slipped in) and blown-out highlights.
  function sampleWall(l) {
    const m = l.mask, src = st.src, N = st.N, hist = new Uint32Array(256);
    let n = 0;
    for (let i = 0, j = 0; i < N; i++, j += 4) if (m[i] >= 128) { hist[(54 * src[j] + 183 * src[j + 1] + 19 * src[j + 2]) >> 8]++; n++; }
    if (n < 50) return null;
    const pct = (q) => { let acc = 0, t = n * q; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= t) return v; } return 255; };
    const lo = pct(0.4), hi = pct(0.95);
    let r = 0, g = 0, b = 0, c = 0;
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      if (m[i] < 128) continue;
      const y = (54 * src[j] + 183 * src[j + 1] + 19 * src[j + 2]) >> 8;
      if (y < lo || y > hi) continue;
      r += S2L[src[j]]; g += S2L[src[j + 1]]; b += S2L[src[j + 2]]; c++;
    }
    if (!c) return null;
    const h2 = (v) => toS(v / c).toString(16).padStart(2, '0');
    return '#' + h2(r) + h2(g) + h2(b);
  }

  // ───────────────────────── rendering ─────────────────────────
  // Shading curve for measured walls: shading (0…SH_MAX, 1 = well lit) → shading^g, as a lookup table per Light value.
  const SH_MAX = 4, SH_N = 4096, shLuts = new Map();
  function shadeLut(light) {
    let t = shLuts.get(light);
    if (!t) {
      const g = Math.pow(2, -light / 50); t = new Float32Array(SH_N + 1);
      for (let i = 0; i <= SH_N; i++) t[i] = Math.pow((i / SH_N) * SH_MAX, g);
      shLuts.set(light, t);
    }
    return t;
  }
  function render(x0 = 0, y0 = 0, x1 = st.W, y1 = st.H) {
    if (!st.src) return;
    x0 = clamp(x0 | 0, 0, st.W); y0 = clamp(y0 | 0, 0, st.H); x1 = clamp(Math.ceil(x1), 0, st.W); y1 = clamp(Math.ceil(y1), 0, st.H);
    if (x1 <= x0 || y1 <= y0) return;
    const W = st.W, src = st.src, out = st.out.data;
    const Ls = [];
    for (const l of st.layers) {
      if (!l.visible || l.op <= 0 || !l.count) continue;
      // Paint physics: the photo shows (wall colour × light). Swap the wall colour, keep the light:
      //   new pixel = photo pixel × newPaint / currentWallColour   (per channel, linear light)
      const c = hexToRgb(l.color), o = hexToRgb(l.orig || WALL_NOW[0][1]), bf = 1 + l.bright / 100;
      if (l.origAuto) {
        // Start from a white wall: keep only the light (grey shading), then paint it.
        const yRef = 0.2126 * S2L[o[0]] + 0.7152 * S2L[o[1]] + 0.0722 * S2L[o[2]];
        Ls.push({ grey: true, soft: l.soft, op: l.op / 255, yk: SH_N / SH_MAX / Math.max(0.02, yRef), lut: shadeLut(l.light || 0), pr: S2L[c[0]] * bf, pg: S2L[c[1]] * bf, pb: S2L[c[2]] * bf });
        continue;
      }
      Ls.push({ soft: l.soft, op: l.op / 255, pr: (S2L[c[0]] * bf) / Math.max(0.02, S2L[o[0]]), pg: (S2L[c[1]] * bf) / Math.max(0.02, S2L[o[1]]), pb: (S2L[c[2]] * bf) / Math.max(0.02, S2L[o[2]]) });
    }
    const n = Ls.length;
    for (let y = y0; y < y1; y++) {
      let i = y * W + x0;
      for (let x = x0; x < x1; x++, i++) {
        const j = i << 2;
        let r = S2L[src[j]], g = S2L[src[j + 1]], b = S2L[src[j + 2]];
        if (n) {
          const r0 = r, g0 = g, b0 = b;
          for (let k = 0; k < n; k++) {
            const L = Ls[k], a = L.soft[i];
            if (!a) continue;
            const t = a * L.op;
            if (L.grey) {
              let q = ((0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0) * L.yk) | 0; if (q > SH_N) q = SH_N;
              const f = L.lut[q];
              r += (L.pr * f - r) * t; g += (L.pg * f - g) * t; b += (L.pb * f - b) * t;
            } else { r += (L.pr * r0 - r) * t; g += (L.pg * g0 - g) * t; b += (L.pb * b0 - b) * t; }
          }
        }
        out[j] = toS(r); out[j + 1] = toS(g); out[j + 2] = toS(b); out[j + 3] = 255;
      }
    }
    ctxC.putImageData(st.out, 0, 0, x0, y0, x1 - x0, y1 - y0);
  }

  // Marks the active wall with a dashed outline (no colour fill), so every wall always shows its own paint colour.
  function renderVis(x0 = 0, y0 = 0, x1 = st.W, y1 = st.H) {
    const l = activeLayer(); if (!l || !st.vis) return;
    const T = 3; // outline thickness in photo pixels
    x0 = clamp((x0 | 0) - T, 0, st.W); y0 = clamp((y0 | 0) - T, 0, st.H); x1 = clamp(Math.ceil(x1) + T, 0, st.W); y1 = clamp(Math.ceil(y1) + T, 0, st.H);
    if (x1 <= x0 || y1 <= y0) return;
    const W = st.W, H = st.H, m = l.mask, v = st.vis.data;
    for (let y = y0; y < y1; y++) {
      let i = y * W + x0;
      for (let x = x0; x < x1; x++, i++) {
        const j = i << 2;
        let edge = false;
        if (m[i] >= 128) {
          for (let k = 1; k <= T && !edge; k++) {
            if ((x - k >= 0 && m[i - k] < 128) || (x + k < W && m[i + k] < 128) || (y - k >= 0 && m[i - k * W] < 128) || (y + k < H && m[i + k * W] < 128)) edge = true;
          }
        }
        if (edge) { const c = ((x + y) >> 4) & 1 ? 255 : 20; v[j] = c; v[j + 1] = c; v[j + 2] = c; v[j + 3] = 235; }
        else v[j + 3] = 0;
      }
    }
    ctxM.putImageData(st.vis, 0, 0, x0, y0, x1 - x0, y1 - y0);
  }

  function scheduleRender() {
    if (st.renderQueued) return; st.renderQueued = true;
    requestAnimationFrame(() => { st.renderQueued = false; render(); });
  }
  function renderAll() { render(); renderVis(); }

  // Call after a layer's mask changed inside rect. `final` = the edit is finished (not mid-stroke).
  function maskChanged(l, rect, final = true) {
    const rr = updateSoft(l, rect[0], rect[1], rect[2], rect[3]);
    if (final) {
      let refChanged = updateRef(l);
      for (const x of st.layers) if (x !== l && x.origAuto && updateRef(x)) refChanged = true;
      if (refChanged) scheduleRender(); else render(rr[0], rr[1], rr[2], rr[3]);
      renderLayers();
    } else {
      if (!l.count) l.count = 1;
      render(rr[0], rr[1], rr[2], rr[3]);
    }
    if (l === activeLayer()) renderVis(rect[0], rect[1], rect[2], rect[3]);
    markDirty();
  }

  // ───────────────────────── undo ─────────────────────────
  function pushUndo(e) { st.undo.push(e); if (st.undo.length > 30) st.undo.shift(); st.redo.length = 0; updateUndoButtons(); }
  const snap = (l) => ({ type: 'mask', id: l.id, data: l.mask.slice() });
  // Snapshot of the edited wall plus every wall that has pixels (adding pixels to one wall takes them from others).
  const snapAll = (l) => ({ type: 'masks', active: l.id, items: st.layers.filter((x) => x === l || x.count).map((x) => ({ id: x.id, data: x.mask.slice() })) });

  function applyEntry(e) {
    if (e.type === 'mask') {
      const l = layerById(e.id); if (!l) return null;
      const inv = snap(l); l.mask.set(e.data);
      updateSoftAll(l); updateRef(l);
      st.active = st.layers.indexOf(l);
      return inv;
    }
    if (e.type === 'masks') {
      const inv = { type: 'masks', active: e.active, items: [] };
      for (const it of e.items) {
        const l = layerById(it.id); if (!l) continue;
        inv.items.push({ id: l.id, data: l.mask.slice() });
        l.mask.set(it.data); updateSoftAll(l); updateRef(l);
      }
      const a = st.layers.findIndex((l) => l.id === e.active); if (a >= 0) st.active = a;
      return inv;
    }
    if (e.type === 'delete') { st.layers.splice(e.index, 0, e.layer); st.active = e.index; return { type: 'add', id: e.layer.id }; }
    if (e.type === 'add') {
      const idx = st.layers.findIndex((l) => l.id === e.id); if (idx < 0) return null;
      const [layer] = st.layers.splice(idx, 1); st.active = clamp(st.active, 0, st.layers.length - 1);
      return { type: 'delete', layer, index: idx };
    }
    return null;
  }
  function undoRedo(from, to) {
    const e = from.pop(); if (!e) return;
    releasePickers();
    const inv = applyEntry(e); if (inv) to.push(inv);
    renderAll(); renderLayers(); syncColorPanel(); updateUndoButtons(); markDirty();
  }
  const undo = () => undoRedo(st.undo, st.redo);
  const redo = () => undoRedo(st.redo, st.undo);
  function updateUndoButtons() { $('btn-undo').disabled = !st.undo.length; $('btn-redo').disabled = !st.redo.length; }

  // ───────────────────────── magic wand ─────────────────────────
  async function magicWand(px, py, subtract) {
    const l = activeLayer(); if (!l) return;
    if (!st.lab) {
      const path = st.path, e = cache.get(path);
      busy(true, 'Preparing this photo…'); await nextFrame();
      if (e && e.src) await ensureAnalysis(e);
      if (st.path !== path || !st.lab) { busy(false); return; }
    }
    const { W, H, N, lab, edge } = st; // compact data from analyze.js: lab bytes, edges ×2
    px = clamp(Math.floor(px), 0, W - 1); py = clamp(Math.floor(py), 0, H - 1);
    busy(true, subtract ? 'Removing…' : 'Selecting…'); await nextFrame();
    const es = st.edgeStop * 2;

    // Seed colour = average of a 5×5 patch (skipping strong edges).
    let sL = 0, sa = 0, sb = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = px + dx, y = py + dy; if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x; if (edge[i] > es && !(dx === 0 && dy === 0)) continue;
      sL += lab[i * 3]; sa += lab[i * 3 + 1]; sb += lab[i * 3 + 2]; n++;
    }
    sL /= n; sa /= n; sb /= n;

    const LW = 0.8 / 2.55; // lightness counts less (shadows on a wall shouldn't break the selection); L is stored ×2.55
    const tol2 = st.tol * st.tol;
    const close = (i) => { const k = i * 3, dL = (lab[k] - sL) * LW, da = lab[k + 1] - sa, db = lab[k + 2] - sb; return dL * dL + da * da + db * db <= tol2; };

    const region = new Uint8Array(N), stack = new Int32Array(N);
    let sp = 0;
    const seed = py * W + px; region[seed] = 1; stack[sp++] = seed;
    let minX = px, maxX = px, minY = py, maxY = py;
    while (sp > 0) {
      const i = stack[--sp], x = i % W, y = (i - x) / W;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      let q;
      if (x > 0 && !region[q = i - 1] && edge[q] <= es && close(q)) { region[q] = 1; stack[sp++] = q; }
      if (x < W - 1 && !region[q = i + 1] && edge[q] <= es && close(q)) { region[q] = 1; stack[sp++] = q; }
      if (y > 0 && !region[q = i - W] && edge[q] <= es && close(q)) { region[q] = 1; stack[sp++] = q; }
      if (y < H - 1 && !region[q = i + W] && edge[q] <= es && close(q)) { region[q] = 1; stack[sp++] = q; }
    }

    // The thickened edge barrier stops the fill a few px short of real boundaries. Grow back (up to 8px)
    // into pixels that match the colour and don't sit on a thin edge line.
    {
      const fine = st.fine, fes = es * 2.5;
      let front = [];
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const i = y * W + x; if (!region[i]) continue;
        if ((x > 0 && !region[i - 1]) || (x < W - 1 && !region[i + 1]) || (y > 0 && !region[i - W]) || (y < H - 1 && !region[i + W])) front.push(i);
      }
      for (let it = 0; it < 8 && front.length; it++) {
        const next = [];
        for (const i of front) {
          const x = i % W, y = (i - x) / W;
          const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
          for (const q of nb) {
            if (q < 0 || region[q] || fine[q] > fes || !close(q)) continue;
            region[q] = 1; next.push(q);
            const qx = q % W, qy = (q - qx) / W;
            if (qx < minX) minX = qx; if (qx > maxX) maxX = qx; if (qy < minY) minY = qy; if (qy > maxY) maxY = qy;
          }
        }
        front = next;
      }
    }

    fillHoles(region, minX, minY, maxX, maxY, Math.max(60, Math.round(N * 0.00012)));

    pushUndo(snapAll(l));
    const m = l.mask;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const i = y * W + x; if (!region[i]) continue;
      m[i] = subtract ? 0 : 255;
    }
    if (!subtract) claimPixels(l, [minX, minY, maxX + 1, maxY + 1], true);
    maskChanged(l, [minX, minY, maxX + 1, maxY + 1], true);
    busy(false);
  }

  // "Other-colour wall" tool: the clicked wall gets its own layer with "Match photo" on (its current colour is
  // measured from the photo) and the same paint as the wall you were working on, so it comes out the same colour.
  // Clicking again on such a wall adds to it; ⌥-click removes from it.
  async function matchWall(px, py, subtract) {
    const i = clamp(Math.floor(py), 0, st.H - 1) * st.W + clamp(Math.floor(px), 0, st.W - 1);
    const hit = st.layers.find((x) => x.mask[i] >= 128);
    if (hit && hit.origAuto) { setActive(st.layers.indexOf(hit)); await magicWand(px, py, subtract); return; }
    if (subtract) { if (hit) { setActive(st.layers.indexOf(hit)); await magicWand(px, py, true); } return; }
    const from = hit || activeLayer();
    const l = newLayer(nextWallName(), from ? from.color : NEW_LAYER_COLORS[0]);
    if (from) { l.bright = from.bright; l.op = from.op; l.light = from.origAuto ? from.light || 0 : 0; }
    l.origAuto = true;
    st.layers.push(l); pushUndo({ type: 'add', id: l.id });
    setActive(st.layers.length - 1);
    await magicWand(px, py, false);
    if (!l.count) toast('Nothing selected there — try a higher Colour tolerance');
    else toast(`${l.name}: measured as ${l.orig.toUpperCase()}, painted ${normHex(l.color).toUpperCase()}`);
  }

  // Each pixel belongs to at most one wall: what was just added to wall `l` inside rect is taken away from the others.
  function claimPixels(l, rect, final) {
    const W = st.W, m = l.mask;
    const x0 = Math.max(0, rect[0] | 0), y0 = Math.max(0, rect[1] | 0), x1 = Math.min(st.W, Math.ceil(rect[2])), y1 = Math.min(st.H, Math.ceil(rect[3]));
    for (const o of st.layers) {
      if (o === l || !o.count) continue;
      const om = o.mask; let changed = false;
      for (let y = y0; y < y1; y++) {
        let i = y * W + x0;
        for (let x = x0; x < x1; x++, i++) { const v = m[i]; if (v && om[i]) { const lim = 255 - v; if (om[i] > lim) { om[i] = lim; changed = true; } } }
      }
      if (changed) maskChanged(o, [x0, y0, x1, y1], final);
    }
  }

  // Fill small enclosed specks (noise, texture) inside a selection. Bigger holes — switches, sockets, frames — stay.
  function fillHoles(region, x0, y0, x1, y1, maxHole) {
    const W = st.W, bw = x1 - x0 + 1, bh = y1 - y0 + 1, n = bw * bh;
    const seen = new Uint8Array(n), q = new Int32Array(n);
    for (let p0 = 0; p0 < n; p0++) {
      if (seen[p0]) continue;
      const gx = x0 + (p0 % bw), gy = y0 + ((p0 / bw) | 0);
      if (region[gy * W + gx]) { seen[p0] = 1; continue; }
      let head = 0, tail = 0, touches = false;
      q[tail++] = p0; seen[p0] = 1;
      while (head < tail) {
        const p = q[head++], lx = p % bw, ly = (p - lx) / bw;
        if (lx === 0 || ly === 0 || lx === bw - 1 || ly === bh - 1) touches = true;
        const nb = [lx > 0 ? p - 1 : -1, lx < bw - 1 ? p + 1 : -1, ly > 0 ? p - bw : -1, ly < bh - 1 ? p + bw : -1];
        for (const o of nb) {
          if (o < 0 || seen[o]) continue;
          const ox = x0 + (o % bw), oy = y0 + ((o / bw) | 0);
          if (region[oy * W + ox]) continue;
          seen[o] = 1; q[tail++] = o;
        }
      }
      if (!touches && tail <= maxHole) {
        for (let k = 0; k < tail; k++) { const p = q[k]; region[(y0 + ((p / bw) | 0)) * W + x0 + (p % bw)] = 2; }
      }
    }
  }

  // ───────────────────────── brush ─────────────────────────
  function stamp(l, cx, cy, r, add) {
    const { W, H } = st, m = l.mask;
    const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(W, Math.ceil(cx + r + 1));
    const y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(H, Math.ceil(cy + r + 1));
    for (let y = y0; y < y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x < x1; x++) {
        const dx = x + 0.5 - cx;
        let cov = r - Math.sqrt(dx * dx + dy * dy) + 0.5;
        if (cov <= 0) continue; if (cov > 1) cov = 1;
        const i = y * W + x, v = (cov * 255) | 0;
        if (add) { if (m[i] < v) m[i] = v; } else { const lim = 255 - v; if (m[i] > lim) m[i] = lim; }
      }
    }
    return [x0, y0, x1, y1];
  }
  const union = (a, b) => (a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b);

  function strokeTo(p) {
    const d = st.drag, r = st.size / 2;
    const dx = p.x - d.last.x, dy = p.y - d.last.y, dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, r * 0.3)));
    let rect = null;
    for (let s = 1; s <= steps; s++) rect = union(rect, stamp(d.layer, d.last.x + (dx * s) / steps, d.last.y + (dy * s) / steps, r, d.add));
    d.last = p; d.rect = union(d.rect, rect);
    if (d.add) claimPixels(d.layer, rect, false);
    maskChanged(d.layer, rect, false);
  }

  // ───────────────────────── polygon lasso ─────────────────────────
  function closePoly(subtract) {
    const l = activeLayer(), pts = (st.poly || []).filter((p, i, a) => i === 0 || Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) > 0.5);
    st.poly = null; drawUI();
    if (!l || pts.length < 3) return;
    const ctx = getScratch(), { W, H } = st;
    const bx0 = clamp(Math.floor(Math.min(...pts.map((p) => p.x))) - 1, 0, W), bx1 = clamp(Math.ceil(Math.max(...pts.map((p) => p.x))) + 1, 0, W);
    const by0 = clamp(Math.floor(Math.min(...pts.map((p) => p.y))) - 1, 0, H), by1 = clamp(Math.ceil(Math.max(...pts.map((p) => p.y))) + 1, 0, H);
    if (bx1 <= bx0 || by1 <= by0) return;
    ctx.clearRect(0, 0, W, H);
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y); ctx.closePath();
    ctx.fillStyle = '#fff'; ctx.fill();
    const d = ctx.getImageData(bx0, by0, bx1 - bx0, by1 - by0).data;
    ctx.clearRect(0, 0, W, H);
    pushUndo(snapAll(l));
    const m = l.mask, bw = bx1 - bx0;
    for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) {
      const a = d[((y - by0) * bw + (x - bx0)) * 4 + 3]; if (!a) continue;
      const i = y * W + x;
      if (subtract) { const lim = 255 - a; if (m[i] > lim) m[i] = lim; } else if (m[i] < a) m[i] = a;
    }
    if (!subtract) claimPixels(l, [bx0, by0, bx1, by1], true);
    maskChanged(l, [bx0, by0, bx1, by1], true);
  }

  // ───────────────────────── view: pan & zoom ─────────────────────────
  // Keep the photo on screen: centred when it fits, otherwise at most a small margin past its edges.
  function clampView() {
    const v = st.view, sw = stage.clientWidth, sh = stage.clientHeight, m = 40;
    const iw = st.W * v.s, ih = st.H * v.s;
    v.x = iw <= sw ? (sw - iw) / 2 : clamp(v.x, sw - iw - m, m);
    // vertically: leave TOP_BAR px free at the top for the size control when the photo fits
    v.y = ih <= sh - TOP_BAR - 28 ? TOP_BAR + (sh - TOP_BAR - 28 - ih) / 2 : ih <= sh ? (sh - ih) / 2 : clamp(v.y, sh - ih - m, m);
  }
  const TOP_BAR = 60;
  function applyView() {
    if (st.W) clampView();
    const v = st.view;
    world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.s})`;
    world.style.imageRendering = v.s >= 2.5 ? 'pixelated' : 'auto';
    for (const c of [cvC, cvO, cvM]) c.style.imageRendering = world.style.imageRendering;
    $('zoom-label').textContent = Math.round(v.s * 100) + '%';
    drawUI();
  }
  function fit() {
    if (!st.W) return;
    const sw = stage.clientWidth, sh = stage.clientHeight, pad = 28;
    const s = Math.min((sw - pad * 2) / st.W, (sh - TOP_BAR - pad) / st.H);
    st.view = { s, x: (sw - st.W * s) / 2, y: TOP_BAR + (sh - TOP_BAR - pad - st.H * s) / 2 };
    applyView();
  }
  function zoomAt(sx, sy, factor) {
    const v = st.view, ns = clamp(v.s * factor, 0.1, 16);
    const ix = (sx - v.x) / v.s, iy = (sy - v.y) / v.s;
    st.view = { s: ns, x: sx - ix * ns, y: sy - iy * ns };
    applyView();
  }
  const zoomCenter = (f) => zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, f);
  function screenPt(e) { const r = stage.getBoundingClientRect(); return { sx: e.clientX - r.left, sy: e.clientY - r.top }; }
  function toImage(sx, sy) { const v = st.view; return { x: (sx - v.x) / v.s, y: (sy - v.y) / v.s }; }
  function toScreen(x, y) { const v = st.view; return { x: x * v.s + v.x, y: y * v.s + v.y }; }

  // ───────────────────────── UI overlay (brush cursor, lasso) ─────────────────────────
  function resizeUI() {
    const dpr = window.devicePixelRatio || 1;
    cvU.width = Math.round(stage.clientWidth * dpr); cvU.height = Math.round(stage.clientHeight * dpr);
    ctxU.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawUI();
  }
  function drawUI() {
    ctxU.clearRect(0, 0, cvU.width, cvU.height);
    if (!st.src) return;
    const h = st.hover;
    if ((st.tool === 'brush' || st.tool === 'erase') && h && !st.spaceDown && !(st.drag && st.drag.type === 'pan')) {
      const r = Math.max(1, (st.size / 2) * st.view.s);
      ctxU.lineWidth = 3; ctxU.strokeStyle = 'rgba(0,0,0,.55)';
      ctxU.beginPath(); ctxU.arc(h.sx, h.sy, r, 0, Math.PI * 2); ctxU.stroke();
      ctxU.lineWidth = 1.2; ctxU.strokeStyle = isSub() ? '#ff9b85' : '#fff';
      ctxU.beginPath(); ctxU.arc(h.sx, h.sy, r, 0, Math.PI * 2); ctxU.stroke();
      ctxU.fillStyle = '#fff'; ctxU.fillRect(h.sx - 1, h.sy - 1, 2, 2);
    }
    if (st.poly && st.poly.length) {
      const pts = st.poly.map((p) => toScreen(p.x, p.y));
      const sub = isSub();
      const col = sub ? '#ff9b85' : '#4cc3ff';
      ctxU.beginPath(); ctxU.moveTo(pts[0].x, pts[0].y);
      for (const p of pts.slice(1)) ctxU.lineTo(p.x, p.y);
      if (h) ctxU.lineTo(h.sx, h.sy);
      ctxU.fillStyle = sub ? 'rgba(255,155,133,.12)' : 'rgba(76,195,255,.12)'; ctxU.fill();
      ctxU.lineWidth = 3; ctxU.strokeStyle = 'rgba(0,0,0,.5)'; ctxU.stroke();
      ctxU.lineWidth = 1.5; ctxU.strokeStyle = col; ctxU.setLineDash([6, 4]); ctxU.stroke(); ctxU.setLineDash([]);
      const nearFirst = h && pts.length >= 3 && Math.hypot(h.sx - pts[0].x, h.sy - pts[0].y) < 10;
      pts.forEach((p, i) => {
        ctxU.beginPath(); ctxU.arc(p.x, p.y, i === 0 ? (nearFirst ? 7 : 5) : 3.5, 0, Math.PI * 2);
        ctxU.fillStyle = i === 0 && nearFirst ? col : '#fff'; ctxU.fill(); ctxU.lineWidth = 1.5; ctxU.strokeStyle = 'rgba(0,0,0,.6)'; ctxU.stroke();
      });
    }
  }
  const isSub = () => (st.mode === 'sub') !== st.altDown || (st.tool === 'erase');
  function updateCursor() {
    cvU.classList.remove('grab', 'grabbing', 'none');
    if (st.drag && st.drag.type === 'pan') cvU.classList.add('grabbing');
    else if (st.spaceDown) cvU.classList.add('grab');
    else if (st.tool === 'brush' || st.tool === 'erase') cvU.classList.add('none');
  }

  // ───────────────────────── pointer input ─────────────────────────
  cvU.addEventListener('contextmenu', (e) => e.preventDefault());
  cvU.addEventListener('pointerdown', (e) => {
    if (!st.src) return;
    const { sx, sy } = screenPt(e);
    st.altDown = e.altKey;
    if (e.button === 1 || e.button === 2 || st.spaceDown) {
      st.drag = { type: 'pan', sx, sy, vx: st.view.x, vy: st.view.y };
      cvU.setPointerCapture(e.pointerId); updateCursor(); return;
    }
    if (e.button !== 0) return;
    const p = toImage(sx, sy);
    const inside = p.x >= 0 && p.y >= 0 && p.x < st.W && p.y < st.H;
    const l = activeLayer();
    if (!l) return;
    if (!l.visible) { l.visible = true; renderLayers(); scheduleRender(); }
    if (st.tool === 'wand') { if (inside) magicWand(p.x, p.y, isSub()); return; }
    if (st.tool === 'match') { if (inside) matchWall(p.x, p.y, isSub()); return; }
    if (st.tool === 'lasso') {
      const px = { x: clamp(p.x, 0, st.W), y: clamp(p.y, 0, st.H) };
      if (!st.poly) st.poly = [px];
      else {
        const f = toScreen(st.poly[0].x, st.poly[0].y);
        if (st.poly.length >= 3 && Math.hypot(sx - f.x, sy - f.y) < 10) closePoly(isSub());
        else st.poly.push(px);
      }
      drawUI(); return;
    }
    if (st.tool === 'brush' || st.tool === 'erase') {
      pushUndo(snapAll(l));
      st.drag = { type: 'stroke', layer: l, last: p, add: !isSub(), rect: null };
      cvU.setPointerCapture(e.pointerId);
      const rect = stamp(l, p.x, p.y, st.size / 2, st.drag.add);
      st.drag.rect = rect;
      if (st.drag.add) claimPixels(l, rect, false);
      maskChanged(l, rect, false);
    }
  });
  cvU.addEventListener('pointermove', (e) => {
    const { sx, sy } = screenPt(e);
    st.hover = { sx, sy }; st.hoverFromSlider = false;
    st.altDown = e.altKey;
    const d = st.drag;
    if (d && d.type === 'pan') { st.view.x = d.vx + sx - d.sx; st.view.y = d.vy + sy - d.sy; applyView(); return; }
    if (d && d.type === 'stroke') {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ce of evs.length ? evs : [e]) { const s2 = screenPt(ce); strokeTo(toImage(s2.sx, s2.sy)); }
    }
    if (st.src) {
      const p = toImage(sx, sy);
      $('status-pos').textContent = p.x >= 0 && p.y >= 0 && p.x < st.W && p.y < st.H ? `${Math.floor(p.x)}, ${Math.floor(p.y)}` : '';
    }
    drawUI();
  });
  const endDrag = () => {
    const d = st.drag; st.drag = null;
    if (d && d.type === 'stroke') {
      let changed = false;
      for (const x of st.layers) if (updateRef(x)) changed = true;
      if (changed) scheduleRender();
      renderLayers(); markDirty();
    }
    updateCursor(); drawUI();
  };
  cvU.addEventListener('pointerup', endDrag);
  cvU.addEventListener('pointercancel', endDrag);
  cvU.addEventListener('pointerleave', () => { st.hover = null; drawUI(); });
  cvU.addEventListener('dblclick', () => { if (st.tool === 'lasso' && st.poly) closePoly(isSub()); });
  stage.addEventListener('wheel', (e) => {
    if (!st.src) return;
    e.preventDefault();
    const { sx, sy } = screenPt(e);
    const zooming = e.ctrlKey || e.metaKey || e.altKey;
    let dx = e.deltaX, dy = e.deltaY, rate = e.ctrlKey && !e.metaKey ? 0.012 : 0.004;
    if (!isMac) {
      if (e.deltaMode === 1) { dx *= 32; dy *= 32; }               // wheel reported in lines instead of pixels
      // Ctrl + a mouse-wheel notch arrives as one big step (a touchpad pinch sends many small ones):
      // keep it to roughly 1.25× per notch instead of 3–4×.
      if (zooming && Math.abs(dy) >= 40) rate = 0.0022;
      if (!zooming && e.shiftKey && !dx) { dx = dy; dy = 0; }      // Shift + wheel pans sideways
    }
    if (zooming) zoomAt(sx, sy, Math.exp(-dy * rate));
    else { st.view.x -= dx; st.view.y -= dy; applyView(); }
  }, { passive: false });
  new ResizeObserver(() => { resizeUI(); if (st.W) applyView(); }).observe(stage);

  // ───────────────────────── panel ─────────────────────────
  const TOOL_INFO = {
    wand: ['Magic wand', 'Click a wall to select it — shadows and light are followed, edges stop it. Click more spots to add; ⌥-click removes.'],
    lasso: ['Polygon lasso', 'Click around a wall’s corners. Close by clicking the first point, double-clicking or pressing Enter. Great for straight edges.'],
    brush: ['Brush', 'Paint to add to the active wall’s selection.'],
    erase: ['Eraser', 'Paint to remove from the selection, e.g. over furniture, frames or plants.'],
    match: ['Other-colour wall', 'Click a wall that is painted a different colour now (e.g. blue next to white). It becomes its own wall with the same new paint, measured from the photo so it comes out the same colour as the rest. Click more spots to add; ⌥-click removes.'],
  };
  function setTool(t) {
    st.tool = t; st.poly = null;
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    $('tool-title').textContent = TOOL_INFO[t][0];
    $('tool-help').textContent = keys(TOOL_INFO[t][1]);
    document.querySelectorAll('#tool-settings .field[data-for]').forEach((f) => f.classList.toggle('hidden', !f.dataset.for.split(' ').includes(t)));
    $('sizebar').classList.toggle('hidden', t !== 'brush' && t !== 'erase');
    $('sizebar-label').textContent = t === 'erase' ? 'Eraser size' : 'Brush size';
    updateCursor(); setStatus(); drawUI();
  }
  function setMode(m) { st.mode = m; document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === m)); drawUI(); }
  function setStatus() { $('status-tool').textContent = st.src ? `${TOOL_INFO[st.tool][0]} · ${activeLayer() ? activeLayer().name : ''}` : ''; }

  function bindRange(id, outId, get, set, fmt = (v) => v) {
    const el = $(id), out = $(outId);
    el.value = get(); out.textContent = fmt(get());
    el.addEventListener('input', () => { set(+el.value); out.textContent = fmt(+el.value); });
    return () => { el.value = get(); out.textContent = fmt(get()); };
  }
  bindRange('in-tol', 'out-tol', () => st.tol, (v) => { st.tol = v; saveSettings(); });
  bindRange('in-edge', 'out-edge', () => st.edgeStop, (v) => { st.edgeStop = v; saveSettings(); });
  const syncSizeSide = bindRange('in-size', 'out-size', () => st.size, (v) => setSize(v), (v) => v + ' px');
  const syncSizeTop = bindRange('in-size-top', 'out-size-top', () => st.size, (v) => setSize(v), (v) => v + ' px');
  function syncSize() { syncSizeSide(); syncSizeTop(); }
  function setSize(v) {
    st.size = clamp(Math.round(v), 2, 300); syncSize(); saveSettings();
    // show the brush outline in the middle of the photo while sliding, if the mouse isn't over it
    if (!st.hover || st.hoverFromSlider) { st.hover = { sx: stage.clientWidth / 2, sy: stage.clientHeight / 2 }; st.hoverFromSlider = true; }
    drawUI();
  }
  for (const id of ['in-size', 'in-size-top']) $(id).addEventListener('change', () => { if (st.hoverFromSlider) { st.hover = null; st.hoverFromSlider = false; drawUI(); } });
  $('size-down').addEventListener('click', () => setSize(st.size / 1.2));
  $('size-up').addEventListener('click', () => setSize(st.size * 1.2));
  let featherTimer = null;
  bindRange('in-feather', 'out-feather', () => st.feather, (v) => {
    st.feather = v; saveSettings();
    clearTimeout(featherTimer);
    featherTimer = setTimeout(() => { for (const l of st.layers) updateSoftAll(l); render(); }, 60);
  }, (v) => ['sharp', 'soft', 'softer', 'very soft', 'blurry'][v]);
  const syncBright = bindRange('in-bright', 'out-bright', () => (activeLayer() ? activeLayer().bright : 0), (v) => { const l = activeLayer(); if (l) { l.bright = v; scheduleRender(); markDirty(); } }, (v) => (v > 0 ? '+' : '') + v + '%');
  const syncLight = bindRange('in-light', 'out-light', () => (activeLayer() ? activeLayer().light || 0 : 0), (v) => { const l = activeLayer(); if (l) { l.light = v; scheduleRender(); markDirty(); } }, (v) => (v === 0 ? '0' : (v > 0 ? 'lighter +' : 'darker ') + v));
  const syncOp = bindRange('in-op', 'out-op', () => (activeLayer() ? Math.round(activeLayer().op * 100) : 100), (v) => { const l = activeLayer(); if (l) { l.op = v / 100; scheduleRender(); markDirty(); } }, (v) => v + '%');

  function renderLayers() {
    const ul = $('layers'); ul.innerHTML = '';
    st.layers.forEach((l, idx) => {
      const li = document.createElement('li');
      li.className = 'layer' + (idx === st.active ? ' active' : '') + (l.visible ? '' : ' off');
      const pct = st.N ? (l.count / st.N) * 100 : 0;
      li.innerHTML = `<span class="chip" style="background:${l.color}"></span><span class="name"></span><span class="meta">${l.count ? (pct < 1 ? '<1' : Math.round(pct)) + '%' : 'empty'}</span>
        <button class="eye" title="Show/hide">${l.visible
          ? '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'
          : '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/></svg>'}</button>`;
      li.querySelector('.name').textContent = l.name;
      li.addEventListener('click', (e) => {
        if (e.target.closest('.eye')) { l.visible = !l.visible; renderLayers(); scheduleRender(); markDirty(); return; }
        if (e.target.tagName === 'INPUT') return;
        setActive(idx);
      });
      li.querySelector('.name').addEventListener('dblclick', () => {
        const span = li.querySelector('.name'); const inp = document.createElement('input'); inp.value = l.name;
        span.textContent = ''; span.appendChild(inp); inp.focus(); inp.select();
        const done = () => { l.name = inp.value.trim() || l.name; renderLayers(); syncColorPanel(); setStatus(); markDirty(); };
        inp.addEventListener('blur', done);
        inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') inp.blur(); if (ev.key === 'Escape') { inp.value = l.name; inp.blur(); } ev.stopPropagation(); });
      });
      ul.appendChild(li);
    });
  }
  function setActive(idx) { if (idx !== st.active) releasePickers(); st.active = idx; renderLayers(); renderVis(); syncColorPanel(); setStatus(); }

  function syncColorPanel() {
    const l = activeLayer(); if (!l) return;
    $('in-color').value = normHex(l.color);
    $('in-hex').value = normHex(l.color).toUpperCase();
    $('color-name').textContent = paletteName(l.color);
    $('color-for').textContent = '· ' + l.name;
    document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('current', s.dataset.hex.toLowerCase() === normHex(l.color)));
    syncBright(); syncOp();
    $('in-orig').value = normHex(l.orig || WALL_NOW[0][1]);
    const on = WALL_NOW.find((w) => w[1].toLowerCase() === normHex(l.orig || '').toLowerCase());
    $('orig-name').textContent = l.origAuto ? 'measured from photo' : on ? on[0] : normHex(l.orig).toUpperCase();
    document.querySelectorAll('.orig-sw').forEach((b) => b.classList.toggle('current', !l.origAuto && b.dataset.hex.toLowerCase() === normHex(l.orig || '').toLowerCase()));
    $('btn-orig-auto').classList.toggle('on', !!l.origAuto);
    $('btn-orig-auto').setAttribute('aria-pressed', l.origAuto ? 'true' : 'false');
    $('light-field').classList.toggle('hidden', !l.origAuto); syncLight();
  }
  function setOrig(hex, l = activeLayer()) {
    if (!l || !validHex(hex)) return;
    l.orig = normHex(hex); l.origAuto = false; if (l === activeLayer()) syncColorPanel(); scheduleRender(); markDirty();
  }
  // "Match photo": measure this wall's current colour from its selection, so it ends up exactly the new paint
  // no matter what colour it was. Picking a colour by hand switches it off again.
  function setOrigAuto(on, l = activeLayer()) {
    if (!l) return;
    l.origAuto = on;
    if (on) {
      if (!l.count || !sampleWall(l)) toast('Select (part of) the wall first — the colour is measured from the selection');
      updateRef(l);
    }
    if (l === activeLayer()) syncColorPanel();
    scheduleRender(); markDirty();
  }
  $('btn-orig-auto').addEventListener('click', () => { const l = activeLayer(); if (l) setOrigAuto(!l.origAuto, l); });
  function renderOrigSwatches() {
    const box = $('orig-swatches');
    for (const [name, hex] of WALL_NOW) {
      const b = document.createElement('button'); b.className = 'swatch orig-sw'; b.style.background = hex; b.title = name; b.dataset.hex = hex;
      b.addEventListener('click', () => setOrig(hex)); box.appendChild(b);
    }
  }
  $('in-orig').addEventListener('input', (e) => { const l = layerById(picker.orig); if (l) setOrig(e.target.value, l); });
  function setColor(hex, remember = true, l = activeLayer()) {
    if (!l || !validHex(hex)) return;
    l.color = normHex(hex);
    if (remember) {
      st.recent = [l.color, ...st.recent.filter((c) => c !== l.color)].slice(0, 8);
      saveSettings(); renderRecent();
    }
    if (l === activeLayer()) syncColorPanel();
    renderLayers(); scheduleRender(); markDirty();
  }
  function renderSwatches() {
    const box = $('swatches');
    for (const [name, hex] of PALETTE) {
      const b = document.createElement('button'); b.className = 'swatch'; b.style.background = hex; b.title = `${name}  ${hex}`; b.dataset.hex = hex;
      b.addEventListener('click', () => setColor(hex)); box.appendChild(b);
    }
  }
  function renderRecent() {
    const box = $('recent'); box.innerHTML = '';
    $('recent-wrap').classList.toggle('hidden', !st.recent.length);
    for (const hex of st.recent) {
      const b = document.createElement('button'); b.className = 'swatch'; b.style.background = hex; b.title = hex; b.dataset.hex = hex;
      b.addEventListener('click', () => setColor(hex)); box.appendChild(b);
    }
  }
  // The macOS colour window can stay open while you switch walls. Changes from it only go to the wall it was
  // opened for, so picking another wall never pushes a colour onto it.
  const picker = { color: null, orig: null };
  function releasePickers() { picker.color = picker.orig = null; $('in-color').blur(); $('in-orig').blur(); }
  for (const ev of ['click', 'focus']) {
    $('in-color').addEventListener(ev, () => { picker.color = activeLayer() ? activeLayer().id : null; });
    $('in-orig').addEventListener(ev, () => { picker.orig = activeLayer() ? activeLayer().id : null; });
  }
  $('in-color').addEventListener('input', (e) => { const l = layerById(picker.color); if (l) setColor(e.target.value, false, l); });
  $('in-color').addEventListener('change', (e) => { const l = layerById(picker.color); if (l) setColor(e.target.value, true, l); });
  $('in-hex').addEventListener('change', (e) => { if (validHex(e.target.value)) setColor(e.target.value); else syncColorPanel(); });
  $('in-hex').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); });

  $('btn-add-layer').addEventListener('click', () => {
    if (!st.src) return;
    const l = newLayer(nextWallName(), NEW_LAYER_COLORS[st.layers.length % NEW_LAYER_COLORS.length]);
    st.layers.push(l); pushUndo({ type: 'add', id: l.id });
    setActive(st.layers.length - 1); markDirty();
    if (st.tool !== 'wand' && st.tool !== 'lasso') setTool('wand');
  });
  $('btn-del-layer').addEventListener('click', () => {
    const l = activeLayer(); if (!l) return;
    if (st.layers.length === 1) { clearSelection(); return; }
    const idx = st.active; st.layers.splice(idx, 1);
    pushUndo({ type: 'delete', layer: l, index: idx });
    st.active = clamp(idx, 0, st.layers.length - 1);
    renderAll(); renderLayers(); syncColorPanel(); markDirty();
    toast(keys(`Deleted “${l.name}” — ⌘Z brings it back`));
  });
  function clearSelection() {
    const l = activeLayer(); if (!l || !l.count) return;
    pushUndo(snapAll(l)); l.mask.fill(0); maskChanged(l, [0, 0, st.W, st.H], true); render();
  }
  $('btn-clear-sel').addEventListener('click', clearSelection);

  document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('btn-fit').addEventListener('click', fit);
  $('btn-zoom-in').addEventListener('click', () => zoomCenter(1.25));
  $('btn-zoom-out').addEventListener('click', () => zoomCenter(0.8));
  function setOverlay(on) { st.overlay = on; cvM.style.display = on ? '' : 'none'; $('btn-overlay').classList.toggle('on', on); }
  $('btn-overlay').addEventListener('click', () => setOverlay(!st.overlay));
  function setCompare(on) { document.body.classList.toggle('comparing', on); $('btn-compare').classList.toggle('pressed', on); }
  $('btn-compare').addEventListener('pointerdown', () => setCompare(true));
  for (const ev of ['pointerup', 'pointerleave']) $('btn-compare').addEventListener(ev, () => setCompare(false));
  $('btn-export').addEventListener('click', () => exportImage(false));
  $('btn-export-ba').addEventListener('click', () => exportImage(true));

  // ───────────────────────── Windows / Linux ─────────────────────────
  // None of this runs on macOS.
  if (!isMac) {
    // Show Ctrl / Alt / Shift instead of ⌘ ⌥ ⇧ in tooltips and in the Shortcuts list.
    document.querySelectorAll('[title]').forEach((el) => { el.title = keys(el.title); });
    document.querySelectorAll('.keys dt, .keys dd').forEach((el) => { el.textContent = keys(el.textContent); });

    const isTextField = (t) => !!t && (t.tagName === 'TEXTAREA' || t.isContentEditable
      || (t.tagName === 'INPUT' && !['range', 'color', 'checkbox', 'radio', 'button'].includes(t.type)));

    if (isTauri) {
      // The webview's own right-click menu (Back, Refresh, Print…) would reload the app and lose the view;
      // keep it only on text fields, where it offers cut / copy / paste.
      window.addEventListener('contextmenu', (e) => { if (!isTextField(e.target)) e.preventDefault(); });

      // The webview's own browser shortcuts: reload, print, find, page zoom, caret browsing…
      const BROWSER_KEYS = ['KeyR', 'KeyP', 'KeyF', 'KeyG', 'KeyJ', 'KeyU', 'KeyH', 'KeyD', 'KeyE',
        'Equal', 'Minus', 'Digit0', 'NumpadAdd', 'NumpadSubtract', 'Numpad0'];
      window.addEventListener('keydown', (e) => {
        if (['F3', 'F5', 'F7'].includes(e.code) || ((e.ctrlKey || e.metaKey) && !e.altKey && BROWSER_KEYS.includes(e.code))) e.preventDefault();
      }, true);
    }

    // Tapping Alt on its own (used here for "subtract") otherwise moves keyboard focus to the window menu,
    // after which the next shortcuts are swallowed.
    for (const ev of ['keydown', 'keyup']) window.addEventListener(ev, (e) => { if (e.key === 'Alt') e.preventDefault(); }, true);

    // Unlike on macOS, a clicked button or slider keeps keyboard focus here. Then Space / Enter would press the
    // button again and the arrow keys would move the slider as well as switching photo. Give focus back after a click.
    let pressed = null;
    window.addEventListener('pointerdown', (e) => {
      pressed = e.target && e.target.closest ? e.target.closest('button, input[type=range]') : null;
    }, true);
    for (const ev of ['pointerup', 'pointercancel']) window.addEventListener(ev, () => {
      const el = pressed; pressed = null;
      if (el) setTimeout(() => el.blur(), 0);
    }, true);
    document.addEventListener('change', (e) => { if (e.target && e.target.type === 'color') e.target.blur(); });
  }

  // ───────────────────────── keyboard ─────────────────────────
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    st.altDown = e.altKey;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.code === 'KeyY') { e.preventDefault(); redo(); return; }
    if (mod && e.code === 'KeyS') { e.preventDefault(); exportImage(false); return; }
    if (mod && e.code === 'KeyO') { e.preventDefault(); chooseFolder(); return; }
    if (mod) return;
    switch (e.code) {
      case 'ArrowLeft': case 'ArrowRight': stepPhoto(e.code === 'ArrowRight' ? 1 : -1); break;
      case 'KeyW': setTool('wand'); break;
      case 'KeyL': setTool('lasso'); break;
      case 'KeyB': setTool('brush'); break;
      case 'KeyE': setTool('erase'); break;
      case 'KeyM': setTool('match'); break;
      case 'KeyH': setOverlay(!st.overlay); break;
      case 'KeyF': fit(); break;
      case 'KeyC': if (!e.repeat) setCompare(true); break;
      case 'Equal': case 'NumpadAdd': zoomCenter(1.25); break;
      case 'Minus': case 'NumpadSubtract': zoomCenter(0.8); break;
      case 'BracketLeft': setSize(st.size / 1.2); break;
      case 'BracketRight': setSize(st.size * 1.2); break;
      case 'Space': e.preventDefault(); if (!st.spaceDown) { st.spaceDown = true; updateCursor(); drawUI(); } break;
      case 'Escape': if (st.poly) { st.poly = null; drawUI(); } break;
      case 'Enter': case 'NumpadEnter': if (st.poly) closePoly(isSub()); break;
      case 'Backspace': case 'Delete': if (st.poly) { st.poly.pop(); if (!st.poly.length) st.poly = null; drawUI(); } break;
      default: return;
    }
    drawUI();
  });
  window.addEventListener('keyup', (e) => {
    st.altDown = e.altKey;
    if (e.code === 'KeyC') setCompare(false);
    if (e.code === 'Space') { st.spaceDown = false; updateCursor(); }
    drawUI();
  });
  window.addEventListener('blur', () => { st.spaceDown = false; st.altDown = false; setCompare(false); updateCursor(); });

  // ───────────────────────── sessions (auto-save per photo) ─────────────────────────
  let saveTimer = null;
  function markDirty() { st.dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 900); }

  // Masks are saved run-length encoded ([value, run lo, run hi]…, base64): a few KB and a few ms,
  // instead of encoding a full-size PNG (which is very slow in Safari's engine).
  function maskEncode(m) {
    let buf = new Uint8Array(1 << 16), p = 0;
    for (let i = 0, n = m.length; i < n;) {
      const v = m[i]; let r = 1;
      while (i + r < n && r < 65535 && m[i + r] === v) r++;
      if (p + 3 > buf.length) { const nb = new Uint8Array(buf.length * 2); nb.set(buf); buf = nb; }
      buf[p++] = v; buf[p++] = r & 255; buf[p++] = r >> 8; i += r;
    }
    let bin = '';
    for (let i = 0; i < p; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, Math.min(p, i + 0x8000)));
    return btoa(bin);
  }
  function maskDecode(str, m) {
    const bin = atob(str);
    for (let p = 0, i = 0; p + 2 < bin.length && i < m.length; p += 3) {
      const v = bin.charCodeAt(p), r = bin.charCodeAt(p + 1) | (bin.charCodeAt(p + 2) << 8);
      m.fill(v, i, Math.min(m.length, i + r)); i += r;
    }
  }
  function serialize() {
    return ({
      v: 2, name: st.name, w: st.W, h: st.H, active: st.active,
      layers: st.layers.map((l) => ({ name: l.name, color: l.color, orig: l.orig, origAuto: !!l.origAuto, light: l.light || 0, op: l.op, bright: l.bright, visible: l.visible, rle: l.count ? maskEncode(l.mask) : null })),
    });
  }
  async function persist(key, data) {
    if (!st.project) return;
    st.project.photos[key] = data;
    st.project.lastPhoto = key;
    await writeProject();
  }
  async function saveNow() {
    clearTimeout(saveTimer);
    if (!st.key || !st.dirty) return;
    st.dirty = false;
    const key = st.key;
    try { await persist(key, serialize()); markThumb(key); } catch (e) { console.warn('save failed', e); toast('Could not save the project file: ' + e); }
  }
  async function restoreSession(json) {
    if (!json) return false;
    let data = json;
    if (typeof json === 'string') { try { data = JSON.parse(json); } catch { return false; } }
    if (!data || !Array.isArray(data.layers) || !data.layers.length) return false;
    const ctx = getScratch();
    for (const s of data.layers) {
      const l = newLayer(s.name || 'Wall', s.color || '#A7B39A');
      l.op = s.op ?? 1; l.bright = s.bright ?? 0; l.visible = s.visible ?? true; if (s.orig && validHex(s.orig)) l.orig = normHex(s.orig);
      l.origAuto = !!s.origAuto; l.light = s.light ?? 0;
      if (s.rle && data.w === st.W && data.h === st.H) maskDecode(s.rle, l.mask);
      else if (s.mask) { // older saves stored a PNG
        const img = await new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = s.mask; });
        if (img) {
          ctx.clearRect(0, 0, st.W, st.H); ctx.drawImage(img, 0, 0, st.W, st.H);
          const d = ctx.getImageData(0, 0, st.W, st.H).data;
          for (let i = 0, j = 0; i < st.N; i++, j += 4) l.mask[i] = d[j];
        }
      }
      updateSoftAll(l); updateRef(l);
      st.layers.push(l);
    }
    st.active = clamp(data.active | 0, 0, st.layers.length - 1);
    return true;
  }
  function stashCurrentDoc() {
    if (!st.key) return;
    if (st.dirty) saveNow();
    st.docs.set(st.path, { layers: st.layers, active: st.active, undo: st.undo.slice(-5), redo: [], feather: st.feather });
  }
  window.addEventListener('beforeunload', () => { if (st.dirty) saveNow(); });

  // ───────────────────────── projects: a folder of photos ─────────────────────────
  // Open any folder: its photos are listed in the strip. Your work (walls, colours, selections for every photo)
  // is saved in a project file inside that folder, so the folder can be moved, backed up or shared as a whole.
  // A folder without a project file just starts fresh; the file is created when you first paint something.
  const PROJECT_FILE = 'wall-painter.json';
  const joinPath = (dir, name) => { const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'; return dir.replace(/[\\/]+$/, '') + sep + name; };
  const projectPath = () => joinPath(st.folder, PROJECT_FILE);
  const emptyProject = () => ({ app: 'wall-painter', version: 1, lastPhoto: null, photos: {} });

  async function readImageBlob(path) {
    if (isTauri) return new Blob([await invoke('read_file', { path })]);
    const res = await fetch(path); if (!res.ok) throw new Error(res.status + ' ' + path);
    return res.blob();
  }
  // What's saved for a photo: its entry in the project file, or else work from before projects existed
  // (stored per photo in the app's data folder) so nothing gets lost.
  async function savedFor(path) {
    const name = basename(path);
    const entry = st.project && st.project.photos[name];
    if (entry) return { data: entry };
    if (!isTauri) return null;
    for (const key of ['photos/' + name, path]) {
      try { const json = await invoke('load_session', { key }); if (json) return { data: json, legacy: true }; } catch { /* none */ }
    }
    return null;
  }

  // Writes are queued so two saves never overlap; each writes the whole (small) project file.
  let writeChain = Promise.resolve();
  function writeProject() {
    const folder = st.folder, file = projectPath(), text = JSON.stringify(st.project);
    writeChain = writeChain.catch(() => {}).then(async () => {
      if (isTauri) await invoke('write_text', { path: file, text });
      else localStorage.setItem('wp:project:' + folder, text);
    });
    return writeChain;
  }
  async function readProject(folder) {
    let text = null;
    try { text = isTauri ? await invoke('read_text', { path: joinPath(folder, PROJECT_FILE) }) : lsGet('wp:project:' + folder); }
    catch (e) { toast('Could not read the project file: ' + e); }
    if (!text) return emptyProject();
    try {
      const p = JSON.parse(text);
      if (!p || typeof p.photos !== 'object' || !p.photos) throw new Error('not a Wall Painter project');
      return p;
    } catch (e) {
      toast(`${PROJECT_FILE} could not be read (${e.message}) — starting fresh; the file is only overwritten once you paint`, 6000);
      return emptyProject();
    }
  }

  function closeFolder() {
    if (st.dirty) saveNow();
    st.gen++;
    wanted = null;
    st.path = null; st.key = null; st.name = ''; st.src = null; st.lab = st.edge = st.fine = null;
    st.layers = []; st.undo = []; st.redo = []; st.active = 0; st.docs.clear(); st.dirty = false;
    st.files = []; cache.clear(); st.preloadMsg = ''; setInfo();
    for (const c of [cvC, cvO, cvM]) { const x = c.getContext('2d'); x.clearRect(0, 0, c.width, c.height); }
    $('strip-inner').innerHTML = ''; $('strip').classList.add('hidden');
    renderLayers(); updateUndoButtons(); setStatus();
  }
  function showEmpty(msg, withButton = true) {
    $('empty').classList.remove('hidden');
    $('empty-text').textContent = msg;
    $('btn-open-empty').classList.toggle('hidden', !withButton);
    $('photo-name').textContent = st.folder ? basename(st.folder) : 'No folder open';
  }

  async function openFolder(folder) {
    if (!folder) return;
    closeFolder();
    st.folder = folder;
    showEmpty('Loading photos…', false);
    let files = [];
    try { files = isTauri ? await invoke('list_images', { path: folder }) : []; }
    catch (e) { showEmpty('Could not open this folder: ' + e); return; }
    st.project = await readProject(folder);
    try { localStorage.setItem('wp:folder', folder); } catch { /* ignore */ }
    st.files = files;
    await importOldSessions(files);
    if (!files.length) { showEmpty(`No photos in “${basename(folder)}”. Wall Painter opens JPG, PNG, WebP, BMP and GIF files.`); return; }
    buildStrip();
    const names = files.map(basename);
    let last = null; try { last = localStorage.getItem('wp:last:' + folder); } catch { /* ignore */ }
    if (!names.includes(last)) last = names.includes(st.project.lastPhoto) ? st.project.lastPhoto : names[0];
    await openPath(files[names.indexOf(last)]);
    preloadAll();
  }
  // Work saved by older versions (per photo in the app's data folder) is copied into this folder's project file once.
  async function importOldSessions(files) {
    if (!isTauri) return;
    let n = 0;
    for (const path of files) {
      const name = basename(path); if (st.project.photos[name]) continue;
      for (const key of ['photos/' + name, path]) {
        let json = null; try { json = await invoke('load_session', { key }); } catch { /* none */ }
        if (!json) continue;
        try { const d = JSON.parse(json); if (d && Array.isArray(d.layers)) { st.project.photos[name] = d; n++; break; } } catch { /* skip */ }
      }
    }
    if (n) { await writeProject().catch((e) => toast('Could not save the project file: ' + e)); toast(`Imported earlier work for ${n} photo${n > 1 ? 's' : ''} into ${PROJECT_FILE}`, 4000); }
  }
  async function chooseFolder() {
    if (!isTauri) { toast('Opening folders works in the Wall Painter app'); return; }
    const dir = await invoke('pick_folder', { directory: st.folder ? st.folder : null }).catch((e) => { toast(String(e)); return null; });
    if (dir && dir !== st.folder) openFolder(dir);
  }
  $('btn-open').addEventListener('click', chooseFolder);
  $('btn-open-empty').addEventListener('click', chooseFolder);

  async function loadLibrary() {
    if (!isTauri) { showEmpty('Open this in the Wall Painter desktop app to load a folder of photos.', false); return; }
    let last = null; try { last = localStorage.getItem('wp:folder'); } catch { /* ignore */ }
    if (last && (await invoke('is_dir', { path: last }).catch(() => false))) openFolder(last);
    else showEmpty('Open a folder with photos of your rooms. Your walls and colours are saved in that folder, so you can pick up where you left off.');
  }
  function markActiveThumb(path) {
    document.querySelectorAll('.thumb').forEach((t) => t.classList.toggle('active', t.dataset.path === path));
    const cur = document.querySelector('.thumb.active'); if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
  function stepPhoto(d) {
    if (!st.files.length) return;
    const i = st.files.indexOf(st.path);
    openPath(st.files[(i + d + st.files.length) % st.files.length]);
  }
  async function buildStrip() {
    const strip = $('strip'), inner = $('strip-inner'); inner.innerHTML = '';
    strip.classList.toggle('hidden', !st.files.length);
    const thumbs = st.files.map((p) => {
      const d = document.createElement('div'); d.className = 'thumb' + (p === st.path ? ' active' : ''); d.dataset.path = p; d.title = basename(p);
      const c = document.createElement('canvas'); c.width = 210; c.height = 140; d.appendChild(c);
      const lbl = document.createElement('div'); lbl.className = 'lbl'; lbl.textContent = basename(p); d.appendChild(lbl);
      d.addEventListener('click', () => openPath(p));
      inner.appendChild(d);
      return { p, c, d };
    });
    for (const t of thumbs) {
      const name = basename(t.p), entry = st.project && st.project.photos[name];
      if (entry) { if (entry.layers && entry.layers.some((l) => l.rle)) markThumb(name); }
      else if (isTauri) invoke('session_exists', { key: 'photos/' + name }).then((has) => has && markThumb(name)).catch(() => {});
    }
  }
  function drawThumb(path, bmp) {
    const t = [...document.querySelectorAll('.thumb')].find((x) => x.dataset.path === path); if (!t) return;
    const c = t.querySelector('canvas'), ctx = c.getContext('2d'), s = Math.max(c.width / bmp.width, c.height / bmp.height);
    ctx.drawImage(bmp, (c.width - bmp.width * s) / 2, (c.height - bmp.height * s) / 2, bmp.width * s, bmp.height * s);
  }
  function markThumb(name) {
    const t = [...document.querySelectorAll('.thumb')].find((x) => basename(x.dataset.path) === name);
    if (t && !t.querySelector('.dot')) { const dot = document.createElement('span'); dot.className = 'dot'; dot.title = 'Has painted walls'; t.appendChild(dot); }
  }

  // ───────────────────────── export ─────────────────────────
  async function exportImage(beforeAfter) {
    if (!st.src) return;
    render();
    let canvas = cvC;
    if (beforeAfter) {
      const gap = Math.round(st.W * 0.015);
      canvas = document.createElement('canvas'); canvas.width = st.W * 2 + gap; canvas.height = st.H;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(cvO, 0, 0); ctx.drawImage(cvC, st.W + gap, 0);
    }
    const base = st.name.replace(/\.[^.]+$/, '');
    const colors = st.layers.filter((l) => l.count && l.visible).map((l) => (paletteName(l.color) || l.color.slice(1)).toLowerCase().replace(/\s+/g, '-'));
    const def = `${base}-${beforeAfter ? 'before-after' : 'painted'}${colors.length ? '-' + colors.slice(0, 3).join('-') : ''}.png`;
    if (isTauri) {
      try {
        const p = await invoke('pick_save', { defaultName: def, directory: st.folder });
        if (!p) return;
        busy(true, 'Saving…'); await nextFrame();
        const jpg = /\.jpe?g$/i.test(p);
        const url = canvas.toDataURL(jpg ? 'image/jpeg' : 'image/png', 0.92);
        await invoke('write_base64', { path: p, data: url.slice(url.indexOf(',') + 1) });
        toast('Saved ' + basename(p));
      } catch (e) { toast('Export failed: ' + e); }
      finally { busy(false); }
    } else {
      const a = document.createElement('a'); a.download = def; a.href = canvas.toDataURL('image/png'); a.click();
    }
  }

  // ───────────────────────── init ─────────────────────────
  renderSwatches(); renderOrigSwatches(); renderRecent(); setTool('wand'); setMode('add'); updateUndoButtons(); resizeUI();
  loadLibrary();

  // exposed for debugging in the devtools console
  window.wallPainter = { st, magicWand, render, closePoly, setColor, openPath, openFolder, cache };
})();
