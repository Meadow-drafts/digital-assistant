// Opening hours from config: given a moment, is support open, and when does it next open.
const DAY = 24 * 60 * 60_000;
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export function createHours({ utcOffsetMinutes, days, open, close }) {
  const opens = minutes(open) * 60_000;
  const closes = minutes(close) * 60_000;
  const local = (ms) => ms + utcOffsetMinutes * 60_000;
  const weekday = (localMs) => new Date(localMs).getUTCDay();
  const intoDay = (localMs) => ((localMs % DAY) + DAY) % DAY;

  return {
    isOpen(ms) {
      const l = local(ms);
      const t = intoDay(l);
      return days.includes(weekday(l)) && t >= opens && t < closes;
    },
    // The next moment support opens, strictly in the future of a closed moment (or the same day's opening if still ahead).
    nextOpen(ms) {
      const l = local(ms);
      const midnight = l - intoDay(l);
      for (let d = 0; d <= 7; d += 1) {
        const start = midnight + d * DAY + opens;
        if (start > l && days.includes(weekday(start))) return start - utcOffsetMinutes * 60_000;
      }
      return null;
    },
  };
}
