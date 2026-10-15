const MAX_AGE_MS = 2 * 60_000;
const MAX_FUTURE_MS = 30_000;
const PATH_CONTEXT_KEYS = new Set(['path', 'capturedAt']);
const SURFACE_CONTEXT_KEYS = new Set(['surface', 'capturedAt']);
const PAGE_REFERENCE = /\b(here|this page|on this page|cette page|sur cette page|ici)\b/i;

// Client supplied page hints are untrusted. Only a fresh exact configured
// route or a known assistant surface with an available guide becomes context.
export function verifiedPageContext(value, { navigation, availableGuides, language, now }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (typeof value.capturedAt !== 'string') return null;

  const capturedAt = Date.parse(value.capturedAt);
  if (!Number.isFinite(capturedAt) || new Date(capturedAt).toISOString() !== value.capturedAt) return null;
  if (capturedAt > now + MAX_FUTURE_MS || now - capturedAt > MAX_AGE_MS) return null;

  if (keys.length === SURFACE_CONTEXT_KEYS.size && keys.every((key) => SURFACE_CONTEXT_KEYS.has(key))) {
    if (value.surface !== 'my-cases') return null;
    const guide = availableGuides.find((candidate) => candidate.id === 'my-cases');
    if (!guide) return null;
    return Object.freeze({
      surface: 'my-cases',
      label: language === 'fr' ? 'Mes dossiers' : 'My cases',
      guides: [{ id: guide.id, title: guide[language].title }],
    });
  }

  if (!navigation || keys.length !== PATH_CONTEXT_KEYS.size || keys.some((key) => !PATH_CONTEXT_KEYS.has(key)) || typeof value.path !== 'string') return null;
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
