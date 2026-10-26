/* AI tablet detector (YOLO, ONNX). Pure helpers + a runner that takes an
   onnxruntime session. Input: a square RGBA frame already letterboxed to S×S. */
(function (root) {
  function toTensor(rgba, S, flip) {
    const n = S * S, t = new Float32Array(3 * n);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const sx = flip ? S - 1 - x : x, p = (y * S + sx) * 4, i = y * S + x;
      t[i] = rgba[p] / 255; t[n + i] = rgba[p + 1] / 255; t[2 * n + i] = rgba[p + 2] / 255;
    }
    return t;
  }
  function decode(out, N, S, conf, flip) {
    const boxes = [];
    for (let j = 0; j < N; j++) {
      const s = out[4 * N + j]; if (s < conf) continue;
      let cx = out[j]; const cy = out[N + j], w = out[2 * N + j], h = out[3 * N + j];
      if (flip) cx = S - cx;
      boxes.push({ x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2, s });
    }
    return boxes;
  }
  function iou(a, b) {
    const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    const I = ix * iy, U = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - I;
    return U > 0 ? I / U : 0;
  }
  function nms(boxes, th) {
    boxes.sort((a, b) => b.s - a.s);
    const keep = [];
    for (const b of boxes) { if (keep.every(k => iou(k, b) < th)) keep.push(b); }
    return keep;
  }
  // also drop boxes that sit almost entirely inside a larger kept box
  function dropNested(boxes) {
    return boxes.filter((b, i) => !boxes.some((o, j) => {
      if (i === j) return false;
      const ix = Math.max(0, Math.min(b.x1, o.x1) - Math.max(b.x0, o.x0)), iy = Math.max(0, Math.min(b.y1, o.y1) - Math.max(b.y0, o.y0));
      const ab = (b.x1 - b.x0) * (b.y1 - b.y0), ao = (o.x1 - o.x0) * (o.y1 - o.y0);
      return ao > ab && ix * iy > ab * 0.75 && o.s >= b.s * 0.8;
    }));
  }
  async function detect(runModel, rgbaSq, S, opts) {
    opts = opts || {};
    const conf = opts.conf ?? 0.25, th = opts.iou ?? 0.5, passes = opts.flip === false ? [false] : [false, true];
    let all = [];
    for (const f of passes) {
      const out = await runModel(toTensor(rgbaSq, S, f));
      const N = out.length / 5;
      all = all.concat(decode(out, N, S, conf, f));
    }
    let keep = nms(all, th);
    if (passes.length > 1) {
      // a tablet seen in only one pass with low confidence is likely noise
      keep = keep.filter(b => b.s >= conf * 1.4 || all.filter(o => o !== b && iou(o, b) > 0.5).length > 0);
    }
    return dropNested(keep);
  }
  const api = { detect, toTensor, nms };
  if (typeof module !== "undefined") module.exports = api; else root.PillAI = api;
})(this);
