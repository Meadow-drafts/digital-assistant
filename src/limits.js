// Rate limits. Every number is configuration: pass `limits` to createService to
// override any of them. The defaults are placeholders: the two global ones are
// the Groq free-plan figures (8,000 tokens/min, 1,000 requests/day), and the
// daily token budget is Groq's free-plan tokens per day for one model; the rest
// follow the safety spec until the bank sets real values.
export const DEFAULT_LIMITS = {
  messagesPerMinute: 10, // per customer
  messagesPerDay: 100, // per customer
  maxMessageChars: 1000,
  maxToolCallsPerTurn: 3,
  tokensPerMinute: 8000, // global, all customers
  requestsPerDay: 1000, // global model requests, all customers
  tokensPerDay: 200000, // global, all customers, rolling 24 hours, tokens actually used (router and summary calls included)
};

export const BUSY = {
  en: 'The assistant is busy right now. Please try again in a moment, or talk to a human agent.',
  fr: "L'assistant est occupé en ce moment. Réessayez dans un instant, ou parlez à un agent.",
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const estimateTokens = (chars) => Math.ceil(chars / 4);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

export class LimitError extends Error {
  constructor(limit) { super(limit); this.limit = limit; }
}

export function createLimiter({ clock, limits = {} }) {
  const cfg = { ...DEFAULT_LIMITS, ...limits };
  const messages = new Map(); // user -> accepted message times (ms)
  const daily = new Map(); // user -> { day, count }
  const tokens = []; // { at, n } for the last 24 hours
  const requests = { day: null, count: 0 };

  const prune = (list, now, window) => { while (list.length && list[0].at <= now - window) list.shift(); };
  const tokensSince = (from) => tokens.reduce((sum, t) => (t.at > from ? sum + t.n : sum), 0);

  return {
    cfg,
    // Tokens used in the last 24 hours, all customers.
    dailyTokens() { const now = clock.now(); prune(tokens, now, DAY); return tokensSince(now - DAY); },
    // Decides whether a message may start a turn. Returns the limit that was hit,
    // or null (and counts the message) when it may proceed.
    admit(user, messageChars) {
      const now = clock.now();
      if (messageChars > cfg.maxMessageChars) return 'message_length';
      const recent = (messages.get(user) ?? []).filter((at) => at > now - MINUTE);
      if (recent.length >= cfg.messagesPerMinute) return 'messages_per_minute';
      const today = dayOf(now);
      const day = daily.get(user)?.day === today ? daily.get(user) : { day: today, count: 0 };
      if (day.count >= cfg.messagesPerDay) return 'messages_per_day';
      if (requests.day === today && requests.count >= cfg.requestsPerDay) return 'requests_per_day';
      prune(tokens, now, DAY);
      if (tokensSince(now - MINUTE) >= cfg.tokensPerMinute) return 'token_budget';
      if (tokensSince(now - DAY) >= cfg.tokensPerDay) return 'daily_token_budget';
      messages.set(user, [...recent, now]);
      daily.set(user, { day: today, count: day.count + 1 });
      return null;
    },
    // Wraps a model so every call adds its tokens to the global budgets: the
    // provider's own count when it reports one (a `{ usage: { totalTokens } }` part),
    // otherwise an estimate from the text. Used for calls outside a customer turn,
    // such as the agent summary.
    track(model) {
      return {
        name: model.name,
        async *chat(request) {
          let chars = JSON.stringify(request.messages ?? '').length;
          let reported = null;
          try {
            for await (const part of model.chat(request)) {
              if (typeof part === 'string') chars += part.length;
              else if (Number.isFinite(part?.usage?.totalTokens)) { reported = part.usage.totalTokens; continue; }
              yield part;
            }
          } finally {
            tokens.push({ at: clock.now(), n: reported ?? estimateTokens(chars) });
          }
        },
      };
    },
    // Wraps the model for one turn: counts requests and tokens, and
    // ends the turn when the model asks for more tool calls than allowed.
    meter(model) {
      let toolCalls = 0;
      const tracked = this.track(model);
      return {
        name: model.name,
        async *chat(request) {
          const today = dayOf(clock.now());
          if (requests.day !== today) { requests.day = today; requests.count = 0; }
          requests.count += 1;
          for await (const part of tracked.chat(request)) {
            if (typeof part === 'string') yield part;
            else if (part?.toolCall && ++toolCalls > cfg.maxToolCallsPerTurn) throw new LimitError('tool_calls');
          }
        },
      };
    },
  };
}

// LIMIT_MESSAGES_PER_MINUTE=20 style overrides; unset or non-numeric values keep the default.
export function loadLimits(env) {
  const out = {};
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const raw = env[`LIMIT_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`];
    const n = Number(raw);
    if (raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out;
}
