// Keeps an eval run inside the provider's free-plan limits (Groq: 8,000 tokens per minute, 1,000 requests per day; Gemini: whatever AI Studio shows, passed as limits).
// It wraps a model: before each call it waits until the estimated tokens of the last minute plus this call fit the
// budget, counts the request against the day (persisted through onUsage so a later run continues the count), and on
// a 429 (rate limited) or 503 (provider overloaded) before any text waits and tries again. The adapter does not report real token usage, so tokens are estimated
// from the prompt size plus a reserve for the reply.
const MINUTE = 60_000;
const RESERVE = { route: 150, answer: 800, summary: 400 };
const CHARS_PER_TOKEN = 3.2;
const MAX_429_RETRIES = 6;

export class DailyLimitError extends Error {
  constructor(count, cap) {
    super(`daily request cap reached (${count}/${cap}); run again tomorrow to continue`);
    this.name = 'DailyLimitError';
  }
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

export function createPacer({
  tokensPerMinute, requestsPerMinute = Infinity, requestsPerDay, clock, sleep, usage = { day: null, count: 0 }, onUsage = () => {},
  reserve = RESERVE, rateLimitWaitMs = 25_000, log = () => {},
}) {
  const window = []; // { at, tokens }
  let halted = null;
  const estimate = (request) => Math.ceil(JSON.stringify(request.messages ?? []).length / CHARS_PER_TOKEN) + (reserve[request.purpose] ?? reserve.answer);

  async function admit(tokens) {
    for (;;) {
      const now = clock.now();
      while (window.length && window[0].at <= now - MINUTE) window.shift();
      const used = window.reduce((sum, w) => sum + w.tokens, 0);
      if (!window.length || (used + tokens <= tokensPerMinute && window.length < requestsPerMinute)) break;
      const wait = window[0].at + MINUTE - now + 250;
      log(`pacing: waiting ${Math.ceil(wait / 1000)}s for the token window`);
      await sleep(wait);
    }
    const now = clock.now();
    const today = dayOf(now);
    if (usage.day !== today) { usage.day = today; usage.count = 0; }
    if (usage.count >= requestsPerDay) throw new DailyLimitError(usage.count, requestsPerDay);
    usage.count += 1;
    window.push({ at: now, tokens });
    onUsage({ ...usage });
  }

  return {
    usage,
    // Set once the daily cap stopped a call, so a runner can stop instead of recording the refusal as an error.
    get halted() { return halted; },
    wrap(model) {
      return {
        name: model.name,
        async *chat(request) {
          const tokens = estimate(request);
          for (let attempt = 0; ; attempt++) {
            try { await admit(tokens); } catch (err) { if (err instanceof DailyLimitError) halted = err; throw err; }
            let started = false;
            const t0 = clock.now();
            log(`calling ${model.name} (${request.purpose ?? 'answer'})...`);
            try {
              for await (const part of model.chat(request)) { if (!started) log(`  first text after ${Math.round((clock.now() - t0) / 100) / 10}s`); started = true; yield part; }
              return;
            } catch (err) {
              if (started || !/^provider returned (429|503)\b/.test(String(err?.message)) || attempt >= MAX_429_RETRIES) throw err;
              log(`${/ 503\b/.test(err.message) ? 'provider busy (503)' : 'rate limited (429)'}: waiting ${Math.ceil(rateLimitWaitMs / 1000)}s`);
              await sleep(rateLimitWaitMs);
            }
          }
        },
      };
    },
  };
}
