// Layout shift meter shared by e2e/cls.spec.ts and e2e/verify.spec.ts (see cls.spec.ts for the definition).
export function meter() {
  const w = window as unknown as { __cls: { native: number; frame: number; moves: string[] } };
  w.__cls = { native: 0, frame: 0, moves: [] };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) w.__cls.native += e.value; })
      .observe({ type: 'layout-shift', buffered: true });
  } catch { /* no Layout Instability API (WebKit) */ }
  const prev = new WeakMap<Element, DOMRect>();
  const tick = () => {
    const vw = innerWidth; const vh = innerHeight; const boxes: [number, number, number, number][] = []; let far = 0;
    for (const el of document.querySelectorAll('#root *')) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const abs = new DOMRect(r.x + scrollX, r.y + scrollY, r.width, r.height);
      const p = prev.get(el);
      prev.set(el, abs);
      if (!p || (Math.abs(p.x - abs.x) < 0.5 && Math.abs(p.y - abs.y) < 0.5)) continue;
      far = Math.max(far, Math.abs(p.x - abs.x), Math.abs(p.y - abs.y));
      for (const b of [p, abs]) boxes.push([b.x - scrollX, b.y - scrollY, b.right - scrollX, b.bottom - scrollY]);
      if (w.__cls.moves.length < 10) w.__cls.moves.push(`${el.tagName.toLowerCase()}.${(el as HTMLElement).className} ${Math.round(abs.y - p.y)}px`);
    }
    if (boxes.length) {
      const N = 40; let hit = 0;
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const x = (i + 0.5) * vw / N; const y = (j + 0.5) * vh / N;
        if (boxes.some(([a, b, c, d]) => x >= a && x <= c && y >= b && y <= d)) hit++;
      }
      w.__cls.frame += (hit / (N * N)) * (far / Math.max(vw, vh));
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
