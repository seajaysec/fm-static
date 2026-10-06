// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Chris Farrell
// The header scope. Static noise when no FM-1 is connected; a two-operator FM trace when one is;
// while writing, the trace resolves out of the noise from left to right as the write advances.

export function createScope(canvas) {
  const ctx = canvas.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  let mode = "static", progress = 0, lock = 0, W = 0, H = 0, raf = 0, t0 = performance.now();

  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  function size() {
    const r = canvas.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // carrier : modulator 1 : 2, index breathing slowly; x in 0..1
  const fm = (x, t) => Math.sin(2 * Math.PI * (5 * x - t * 0.35) + (1.4 + 0.8 * Math.sin(t * 0.6)) * Math.sin(2 * Math.PI * (10 * x - t * 0.7)));

  function frame(now) {
    const t = (now - t0) / 1000;
    const goal = mode === "locked" || mode === "write" ? 1 : 0;
    lock += (goal - lock) * (reduce.matches ? 1 : 0.06);
    ctx.clearRect(0, 0, W, H);

    ctx.strokeStyle = css("--grid"); ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 1; i < 10; i++) { const x = Math.round((W * i) / 10) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let j = 1; j < 4; j++) { const y = Math.round((H * j) / 4) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();

    const mid = H / 2, amp = H * 0.36, step = 2;
    const cursor = mode === "write" ? progress : 1;       // left of the cursor the trace is clean
    const color = mode === "error" ? css("--bad") : css("--trace");
    const line = (alpha, width, seed) => {
      ctx.strokeStyle = color; ctx.globalAlpha = alpha; ctx.lineWidth = width; ctx.beginPath();
      for (let px = 0; px <= W; px += step) {
        const x = px / W;
        let y;
        if (mode === "error") y = 0.02 * Math.sin(x * 40 + t * 3);
        else {
          const clean = lock * (x <= cursor ? 1 : 0.0);
          const noise = (Math.random() - 0.5) * 1.9 * (0.35 + 0.65 * Math.sin(seed + x * 7 + t * 5) ** 2);
          y = fm(x, t) * clean + noise * (1 - clean);
        }
        px ? ctx.lineTo(px, mid - y * amp) : ctx.moveTo(px, mid - y * amp);
      }
      ctx.stroke();
    };
    line(0.22, 5, 0); line(1, 1.6, 1);
    ctx.globalAlpha = 1;
    if (mode === "write") {                                 // the write head
      const x = Math.round(W * progress) + 0.5;
      ctx.strokeStyle = css("--led"); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    if (!reduce.matches || Math.abs(goal - lock) > 0.01) raf = requestAnimationFrame(frame);
    else raf = 0;
  }

  function kick() { if (!raf) raf = requestAnimationFrame(frame); }
  new ResizeObserver(() => { size(); kick(); }).observe(canvas);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", kick);
  size(); kick();

  return {
    set(next) { mode = next.mode ?? mode; progress = next.progress ?? progress; kick(); },
  };
}
