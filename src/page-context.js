const MAX_AGE_MS = 2 * 60_000;
const MAX_FUTURE_MS = 30_000;
const CONTEXT_KEYS = new Set(['path', 'capturedAt']);
const PAGE_REFERENCE = /\b(here|this page|on this page|cette page|sur cette page|ici)\b/i;

// Client supplied page hints are untrusted. Only an exact configured path with
// a fresh capture time and an available guide can become model context.
export function verifiedPageContext(value, { navigation, availableGuides, language, now }) {
  if (!navigation) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== CONTEXT_KEYS.size || keys.some((key) => !CONTEXT_KEYS.has(key))) return null;
  if (typeof value.path !== 'string' || typeof value.capturedAt !== 'string') return null;

  const capturedAt = Date.parse(value.capturedAt);
  if (!Number.isFinite(capturedAt) || new Date(capturedAt).toISOString() !== value.capturedAt) return null;
  if (capturedAt > now + MAX_FUTURE_MS || now - capturedAt > MAX_AGE_MS) return null;

  const routeId = [...navigation.routes].find(([, route]) => route.path === value.path)?.[0];
  if (!routeId) return null;
  const guides = availableGuides.filter((candidate) => candidate.route === value.path);
  if (!guides.length) return null;
  const route = navigation.routes.get(routeId);

  return Object.freeze({
    label: route.labels[language] ?? route.labels.en,
    guides: guides.map((guide) => ({ id: guide.id, title: guide[language].title })),
  });
}

export const asksAboutCurrentPage = (message) => PAGE_REFERENCE.test(message);
