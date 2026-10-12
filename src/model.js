// One OpenAI-compatible adapter. Provider, model and base URL are plain config
// (see loadModelConfig); API keys come from the environment and are only ever
// sent in the Authorization header, never put in errors, events or logs.
function createAdapter({ baseUrl, model, apiKey }) {
  return {
    name: model,
    async *chat({ messages, language }) {
      const hint = { role: 'system', content: language === 'fr' ? 'Reply in French.' : 'Reply in English.' };
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, stream: true, messages: [hint, ...messages] }),
      });
      if (!res.ok) throw new Error(`provider returned ${res.status}`);
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const part of res.body) {
        buffer += decoder.decode(part, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const data = /^data: (.*)$/.exec(line)?.[1];
          if (!data || data === '[DONE]') continue;
          const text = JSON.parse(data).choices?.[0]?.delta?.content;
          if (text) yield text;
        }
      }
    },
  };
}

const OFFLINE_NOTICE = 'I am in offline mode and can only reply in English right now. ';

// Chain: primary, then fallback, then the offline English-only model. The
// caller learns which one answered through request.onServed. Falling back is
// only safe before any text has streamed.
export function createModel({ primary, fallback, offline }) {
  const links = [primary, fallback].filter(Boolean).map((c) => ({ adapter: createAdapter(c) }));
  if (offline) links.push({ adapter: createAdapter(offline), offline: true });
  return {
    name: links[0].adapter.name,
    async *chat(request) {
      let lastError;
      for (const { adapter, offline: isOffline } of links) {
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
        }
      }
      throw lastError;
    },
  };
}

// Reads MODEL_<ROLE>_BASE_URL / _NAME / _API_KEY for PRIMARY, FALLBACK and
// OFFLINE. Returns null when no primary model is configured.
export function loadModelConfig(env) {
  const role = (r) => env[`MODEL_${r}_BASE_URL`] && env[`MODEL_${r}_NAME`]
    ? { baseUrl: env[`MODEL_${r}_BASE_URL`], model: env[`MODEL_${r}_NAME`], apiKey: env[`MODEL_${r}_API_KEY`] }
    : undefined;
  const primary = role('PRIMARY');
  if (!primary) return null;
  return { primary, fallback: role('FALLBACK'), offline: role('OFFLINE') };
}
