/* PillCounter engine — pure functions over RGBA pixels. No DOM.
   countPills(rgba, w, h, opts) -> { count, dots:[{x,y}], unit, mask, pillLab }
   opts: { pillLab:[L,a,b]|null, sens:0..1, roi:{x0,y0,x1,y1} } */
(function (root) {
  const LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function f(t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }

  function rgb2lab(r, g, b) {
    const R = LIN[r], G = LIN[g], B = LIN[b];
    const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
    const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const fx = f(x), fy = f(y), fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  function toLab(rgba, n) {
    const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const lab = rgb2lab(rgba[p], rgba[p + 1], rgba[p + 2]);
      L[i] = lab[0]; A[i] = lab[1]; B[i] = lab[2];
    }
    return { L, A, B };
  }

  // Lightness weighted down so soft shadows count less than colour change
  const LW = 0.55;

  function otsu(hist, total) {
    let sum = 0;
    for (let i = 0; i < hist.length; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 0;
    for (let i = 0; i < hist.length; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = i; }
    }
    return thr;
  }

  function buildMask(lab, w, h, roi, opts) {
    const n = w * h, mask = new Uint8Array(n);
    const { L, A, B } = lab;
    const sens = opts.sens == null ? 0.5 : opts.sens;
    let bg = null;
    if (opts.pillLab) {
      const [pl, pa, pb] = opts.pillLab;
      const C = Math.hypot(pa, pb);
      const k = 0.6 + sens * 0.8;
      if (C >= 12) {
        // coloured tablet: chroma follows lightness, so compare against the
        // colour this tablet would have at the pixel's lightness (handles shade)
        const T = Math.max(8, C * 0.45) * k;
        for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
          const i = y * w + x;
          const sc = Math.min(1.5, Math.max(0.6, (L[i] + 4) / (pl + 4)));
          const dl = (L[i] - pl) * 0.2, da = A[i] - pa * sc, db = B[i] - pb * sc;
          if (dl * dl + da * da + db * db < T * T) mask[i] = 1;
        }
      } else {
        // white / grey tablet: lightness is the signal
        const T = 14 * k;
        for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
          const i = y * w + x;
          const dl = (L[i] - pl) * 0.7, da = A[i] - pa, db = B[i] - pb;
          if (dl * dl + da * da + db * db < T * T) mask[i] = 1;
        }
      }
    } else {
      // dominant colour in ROI = background
      const bins = new Map();
      for (let y = roi.y0; y < roi.y1; y += 2) for (let x = roi.x0; x < roi.x1; x += 2) {
        const i = y * w + x;
        const k = ((L[i] / 6) | 0) * 4096 + (((A[i] + 128) / 6) | 0) * 64 + (((B[i] + 128) / 6) | 0);
        const e = bins.get(k);
        if (e) { e[0]++; e[1] += L[i]; e[2] += A[i]; e[3] += B[i]; } else bins.set(k, [1, L[i], A[i], B[i]]);
      }
      let top = null;
      for (const e of bins.values()) if (!top || e[0] > top[0]) top = e;
      bg = [top[1] / top[0], top[2] / top[0], top[3] / top[0]];
      const hist = new Uint32Array(101); let tot = 0;
      const d = new Float32Array(n);
      for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
        const i = y * w + x;
        const dl = (L[i] - bg[0]) * LW, da = A[i] - bg[1], db = B[i] - bg[2];
        const v = Math.sqrt(dl * dl + da * da + db * db);
        d[i] = v; hist[Math.min(100, v | 0)]++; tot++;
      }
      let thr = otsu(hist, tot);
      thr = Math.max(7, thr * (1.45 - sens * 0.9)); // sens 0.5 -> 1.0x Otsu
      for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
        const i = y * w + x; if (d[i] > thr) mask[i] = 1;
      }
    }
    return { mask, bg };
  }

  function erode(m, w, h) {
    const o = new Uint8Array(m.length);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      o[i] = m[i] & m[i - 1] & m[i + 1] & m[i - w] & m[i + w];
    }
    return o;
  }
  function dilate(m, w, h) {
    const o = new Uint8Array(m.length);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      o[i] = m[i] | m[i - 1] | m[i + 1] | m[i - w] | m[i + w];
    }
    return o;
  }

  function components(m, w, h) {
    const lab = new Int32Array(m.length), comps = [], stack = new Int32Array(m.length);
    let id = 0;
    for (let s = 0; s < m.length; s++) {
      if (!m[s] || lab[s]) continue;
      id++; let sp = 0; stack[sp++] = s; lab[s] = id;
      const px = [];
      while (sp) {
        const i = stack[--sp]; px.push(i);
        const x = i % w;
        if (x > 0 && m[i - 1] && !lab[i - 1]) { lab[i - 1] = id; stack[sp++] = i - 1; }
        if (x < w - 1 && m[i + 1] && !lab[i + 1]) { lab[i + 1] = id; stack[sp++] = i + 1; }
        if (i >= w && m[i - w] && !lab[i - w]) { lab[i - w] = id; stack[sp++] = i - w; }
        if (i < m.length - w && m[i + w] && !lab[i + w]) { lab[i + w] = id; stack[sp++] = i + w; }
      }
      comps.push({ id, px, area: px.length });
    }
    return comps;
  }

  function kmeans(px, w, k) {
    const step = Math.max(1, Math.floor(px.length / 2500));
    const pts = [];
    for (let i = 0; i < px.length; i += step) pts.push([px[i] % w, (px[i] / w) | 0]);
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p[0]; cy += p[1]; }
    cx /= pts.length; cy /= pts.length;
    const C = [];
    let far = pts[0], fd = -1;
    for (const p of pts) { const d = (p[0] - cx) ** 2 + (p[1] - cy) ** 2; if (d > fd) { fd = d; far = p; } }
    C.push([far[0], far[1]]);
    while (C.length < k) {
      let bp = pts[0], bd = -1;
      for (const p of pts) {
        let md = Infinity;
        for (const c of C) md = Math.min(md, (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2);
        if (md > bd) { bd = md; bp = p; }
      }
      C.push([bp[0], bp[1]]);
    }
    for (let it = 0; it < 10; it++) {
      const S = C.map(() => [0, 0, 0]);
      for (const p of pts) {
        let bi = 0, bd = Infinity;
        for (let j = 0; j < k; j++) { const d = (p[0] - C[j][0]) ** 2 + (p[1] - C[j][1]) ** 2; if (d < bd) { bd = d; bi = j; } }
        S[bi][0] += p[0]; S[bi][1] += p[1]; S[bi][2]++;
      }
      for (let j = 0; j < k; j++) if (S[j][2]) { C[j][0] = S[j][0] / S[j][2]; C[j][1] = S[j][1] / S[j][2]; }
    }
    return C.map(c => ({ x: c[0], y: c[1] }));
  }

  // two-pass chamfer distance transform (1, 1.414)
  function distT(m, w, h) {
    const d = new Float32Array(m.length), INF = 1e9, D = 1.4142;
    for (let i = 0; i < m.length; i++) d[i] = m[i] ? INF : 0;
    for (let y = 1; y < h; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x; if (!d[i]) continue;
      d[i] = Math.min(d[i], d[i - 1] + 1, d[i - w] + 1, d[i - w - 1] + D, d[i - w + 1] + D);
    }
    for (let y = h - 2; y >= 0; y--) for (let x = w - 2; x >= 1; x--) {
      const i = y * w + x; if (!d[i]) continue;
      d[i] = Math.min(d[i], d[i + 1] + 1, d[i + w] + 1, d[i + w + 1] + D, d[i + w - 1] + D);
    }
    for (let i = 0; i < m.length; i++) if (d[i] >= INF) d[i] = 0;
    return d;
  }

  // fill enclosed background specks (glare, imprint, score lines)
  function fillHoles(m, w, h, maxArea) {
    const inv = new Uint8Array(m.length);
    for (let i = 0; i < m.length; i++) inv[i] = m[i] ? 0 : 1;
    for (const c of components(inv, w, h)) {
      if (c.area > maxArea) continue;
      let edge = false;
      for (const i of c.px) { const x = i % w, y = (i / w) | 0; if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { edge = true; break; } }
      if (!edge) for (const i of c.px) m[i] = 1;
    }
  }

  function median(a) { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; }

  // auto: background = dominant colour; pill = dominant colour among the rest
  function autoPillLab(lab, w, h, roi, sens) {
    const { L, A, B } = lab;
    const { mask: first, bg } = buildMask(lab, w, h, roi, { sens });
    const bins = new Map();
    let n = 0;
    for (let y = roi.y0; y < roi.y1; y += 2) for (let x = roi.x0; x < roi.x1; x += 2) {
      const i = y * w + x; n++; if (!first[i]) continue;
      const k = ((L[i] / 10) | 0) * 4096 + (((A[i] + 128) / 8) | 0) * 64 + (((B[i] + 128) / 8) | 0);
      const e = bins.get(k);
      if (e) { e[0]++; e[1] += L[i]; e[2] += A[i]; e[3] += B[i]; } else bins.set(k, [1, L[i], A[i], B[i]]);
    }
    // Shadows, foil and hands are grey. If any clearly coloured thing that
    // isn't the background covers enough of the frame, that is the tablet.
    let top = null, topC = null, chromaN = 0;
    for (const e of bins.values()) {
      if (!top || e[0] > top[0]) top = e;
      const a = e[2] / e[0], b = e[3] / e[0];
      if (Math.hypot(a, b) < 13) continue;
      if (bg && Math.hypot(a - bg[1], b - bg[2]) < 12) continue;
      chromaN += e[0];
      if (!topC || e[0] > topC[0]) topC = e;
    }
    const pick = topC && chromaN > n * 0.012 ? topC : top;
    return pick ? [pick[1] / pick[0], pick[2] / pick[0], pick[3] / pick[0]] : null;
  }

  function countPills(rgba, w, h, opts) {
    opts = opts || {};
    const sens = opts.sens == null ? 0.5 : opts.sens;
    const roi = opts.roi || { x0: 0, y0: 0, x1: w, y1: h };
    const lab = toLab(rgba, w * h);
    const pillLab = opts.pillLab || autoPillLab(lab, w, h, roi, sens);
    if (!pillLab) return { count: 0, dots: [], unit: 0, r: 0, pillLab: null };
    let mask = buildMask(lab, w, h, roi, { sens, pillLab }).mask;
    mask = erode(dilate(mask, w, h), w, h);         // fill glare specks
    mask = dilate(erode(mask, w, h), w, h);         // drop hairlines
    fillHoles(mask, w, h, (roi.x1 - roi.x0) * (roi.y1 - roi.y0) * 0.00025);

    const roiArea = (roi.x1 - roi.x0) * (roi.y1 - roi.y0);
    const dt = distT(mask, w, h);
    const lab2 = new Int32Array(w * h);
    const comps = components(mask, w, h);
    comps.forEach((c, ci) => { for (const i of c.px) lab2[i] = ci + 1; });

    // local maxima of the distance map
    const peaks = [];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, v = dt[i]; if (v < 2) continue;
      if (v >= dt[i - 1] && v >= dt[i + 1] && v >= dt[i - w] && v >= dt[i + w] &&
          v >= dt[i - w - 1] && v >= dt[i - w + 1] && v >= dt[i + w - 1] && v >= dt[i + w + 1])
        peaks.push({ x, y, v, c: lab2[i] });
    }
    if (!peaks.length) return { count: 0, dots: [], unit: 0, r: 0, pillLab };
    const vals = peaks.map(p => p.v).sort((a, b) => a - b);
    const hi = vals[Math.floor(vals.length * 0.95)];
    // pill radius: from blobs that look like one round-ish tablet
    const cmax = new Float32Array(comps.length + 1);
    for (const p of peaks) if (p.v > cmax[p.c]) cmax[p.c] = p.v;
    const roundR = [];
    comps.forEach((c, ci) => { const v = cmax[ci + 1]; if (v >= Math.max(3, hi * 0.45)) { const q = c.area / (Math.PI * v * v); if (q > 0.75 && q < 2.6) roundR.push(v); } });
    let r = opts.rHint || (roundR.length >= 2 ? median(roundR) : median(vals.filter(v => v >= hi * 0.6)));
    const minR = r * 0.5, sep2 = (r * 1.45) ** 2;
    peaks.sort((a, b) => b.v - a.v);
    const acc = [];
    for (const p of peaks) {
      if (p.v < minR) break;
      let ok = true;
      for (const q of acc) if ((p.x - q.x) ** 2 + (p.y - q.y) ** 2 < sep2) { ok = false; break; }
      if (ok) acc.push(p);
    }
    // group peaks per component
    const byC = new Map();
    for (const p of acc) { if (!byC.has(p.c)) byC.set(p.c, []); byC.get(p.c).push(p); }

    // area check: unit area from isolated single-peak blobs
    const singleAreas = [];
    for (const [ci, ps] of byC) if (ps.length === 1) singleAreas.push(comps[ci - 1].area);
    let unit = 0;
    if (singleAreas.length >= 3) {
      const m = median(singleAreas);
      const ok = singleAreas.filter(a => a > m * 0.6 && a < m * 1.5);
      if (ok.length >= 3) unit = median(ok);
    }
    const dots = [];
    for (const [ci, ps] of byC) {
      const c = comps[ci - 1];
      if (c.area > roiArea * 0.6) continue;
      let n = ps.length;
      if (unit) {
        const na = Math.round(c.area / unit);
        // elongated tablets give extra peaks; hidden touching pills give too few
        if (na >= 1 && Math.abs(na - n) >= 1 && (n === 1 ? na >= 2 && c.area / unit > 1.7 : true)) n = na;
      }
      // tablets touching each other are the usual source of ±1 errors: flag them
      const chk = n > 1;
      if (n === ps.length) for (const p of ps) dots.push({ x: p.x, y: p.y, chk });
      else for (const d of kmeans(c.px, w, n)) dots.push({ x: d.x, y: d.y, chk });
    }
    return { count: dots.length, dots, unit, r, pillLab };
  }

  function sampleLab(rgba, w, h, x, y, rad) {
    rad = rad || 3; let s = [0, 0, 0], n = 0;
    for (let yy = Math.max(0, y - rad); yy <= Math.min(h - 1, y + rad); yy++)
      for (let xx = Math.max(0, x - rad); xx <= Math.min(w - 1, x + rad); xx++) {
        const p = (yy * w + xx) * 4; const l = rgb2lab(rgba[p], rgba[p + 1], rgba[p + 2]);
        s[0] += l[0]; s[1] += l[1]; s[2] += l[2]; n++;
      }
    return s.map(v => v / n);
  }

  const api = { countPills, sampleLab, rgb2lab };
  if (typeof module !== 'undefined') module.exports = api; else root.PillCounter = api;
})(this);
