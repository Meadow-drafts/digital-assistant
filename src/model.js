// One OpenAI-compatible adapter. Provider, model and base URL are plain config
// (see loadModelConfig); API keys come from the environment and are only ever
// sent in the Authorization header, never put in errors, events or logs.
// Without a temperature the provider's default is used (close to 1 on Groq), and the same message was seen routed
// four different ways. Routing picks a guide or a tag, so it is made as repeatable as the provider allows; answers
// and summaries keep a little room. The caller says which it is with `purpose`.
export const TEMPERATURE = { route: 0, answer: 0.3, summary: 0.2 };

function createAdapter({ baseUrl, model, apiKey, timeoutMs }) {
  return {
    name: model,
    async *chat({ messages, language, purpose }) {
      const hint = { role: 'system', content: language === 'fr' ? 'Reply in French.' : 'Reply in English.' };
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
        body: JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, temperature: TEMPERATURE[purpose] ?? TEMPERATURE.answer, messages: [hint, ...messages] }),
      });
      if (!res.ok) {
        // A short piece of the provider's own explanation, with the key removed, so a 400 or 403 can be diagnosed.
        const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
        const safe = apiKey ? body.split(apiKey).join('[key]') : body;
        throw Object.assign(new Error(`provider returned ${res.status}${safe ? `: ${safe}` : ''}`), { status: res.status, detail: safe });
      }
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const part of res.body) {
        buffer += decoder.decode(part, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const data = /^data: (.*)$/.exec(line)?.[1];
          if (!data || data === '[DONE]') continue;
          const chunk = JSON.parse(data);
          const text = chunk.choices?.[0]?.delta?.content;
          if (text) yield text;
          // The provider's own count, sent once at the end (OpenAI-style `usage`, or Groq's `x_groq.usage`).
          const total = (chunk.usage ?? chunk.x_groq?.usage)?.total_tokens;
          if (Number.isFinite(total)) yield { usage: { totalTokens: total } };
        }
      }
    },
  };
}

// Google's OpenAI-compatible endpoint (ai.google.dev/gemini-api/docs/openai). Its key is read from GEMINI_API_KEY.
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const isGemini = (url) => url?.replace(/\/$/, '') === GEMINI_BASE_URL;

const OFFLINE_NOTICE = 'I am in offline mode and can only reply in English right now. ';

const DAY = 24 * 60 * 60_000;
// A 429 that says the model's tokens for the day are used up (Groq: "... on tokens per day (TPD): Limit 100000,
// Used 99000, Requested 5000. Please try again in 14m3.2s"). Returns how long to leave that model alone, or null
// for any other error. The provider's retry-after can be tiny while the request still does not fit, so the wait is
// the longer of that and the time the missing tokens need to come back at the daily limit spread over 24 hours.
function dailyTokenWait(err) {
  const detail = err?.detail ?? '';
  if (err?.status !== 429 || !/tokens per day|\bTPD\b/i.test(detail)) return null;
  const [, h, m, s] = /try again in (?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?/i.exec(detail) ?? [];
  const retryAfter = (Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)) * 1000;
  const [limit, used, requested] = ['Limit', 'Used', 'Requested'].map((k) => Number(new RegExp(`\\b${k}\\s+(\\d+)`, 'i').exec(detail)?.[1]));
  const missing = used + requested - limit;
  const refill = limit > 0 && missing > 0 ? (missing / limit) * DAY : 0;
  const wait = Math.max(retryAfter || 0, refill || 0);
  return wait > 0 ? Math.ceil(wait) : DAY;
}

// Chain: primary, then fallback, then the offline English-only model. The
// caller learns which one answered through request.onServed. Falling back is
// only safe before any text has streamed. A model whose daily tokens ran out is
// skipped (not asked again) until the wait its provider named has passed.
export function createModel({ primary, fallback, offline, clock = { now: () => Date.now() } }) {
  const links = [primary, fallback].filter(Boolean).map((c) => ({ adapter: createAdapter(c) }));
  if (offline) links.push({ adapter: createAdapter(offline), offline: true });
  return {
    name: links[0].adapter.name,
    async *chat(request) {
      let lastError;
      for (const link of links) {
        const { adapter, offline: isOffline } = link;
        if (link.exhaustedUntil > clock.now()) { lastError ??= link.exhaustedError; continue; }
        let started = false;
        try {
          const turn = isOffline ? { ...request, language: 'en' } : request;
          for await (const text of adapter.chat(turn)) {
            if (!started) {
              started = true;
              request.onServed?.({ model: adapter.name, offline: Boolean(isOffline) });
              if (isOffline) yield OFFLINE_NOTICE;
            }
            yield text;
          }
          return;
        } catch (err) {
          if (started) throw err;
          lastError = err;
          const wait = dailyTokenWait(err);
          if (wait) Object.assign(link, { exhaustedUntil: clock.now() + wait, exhaustedError: err });
        }
      }
      throw lastError;
    },
  };
}

// Reads MODEL_<ROLE>_BASE_URL / _NAME / _API_KEY for PRIMARY, FALLBACK and
// OFFLINE. A role on the Gemini base URL with no _API_KEY of its own uses GEMINI_API_KEY.
// Returns null when no primary model is configured.
export function loadModelConfig(env) {
  const role = (r) => env[`MODEL_${r}_BASE_URL`] && env[`MODEL_${r}_NAME`]
    ? { baseUrl: env[`MODEL_${r}_BASE_URL`], model: env[`MODEL_${r}_NAME`], apiKey: env[`MODEL_${r}_API_KEY`] ?? (isGemini(env[`MODEL_${r}_BASE_URL`]) ? env.GEMINI_API_KEY : undefined) }
    : undefined;
  const primary = role('PRIMARY');
  if (!primary) return null;
  return { primary, fallback: role('FALLBACK'), offline: role('OFFLINE') };
}
