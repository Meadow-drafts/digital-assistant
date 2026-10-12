// Controllable clock. now() is fixed until advance(ms) moves it; timers set via
// setTimeout/clearTimeout fire (in order) as time advances.
export function createFakeClock(start = Date.UTC(2026, 9, 12, 9, 0, 0)) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        await due[1].fn();
      }
      t = target;
    },
  };
}
