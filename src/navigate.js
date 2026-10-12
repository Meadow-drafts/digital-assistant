// Navigate action cards (T2, stories 34 and 43). The model only proposes an action id; the service validates it
// against the route config and the widget draws the card from what this module returns, never from model text.
import { readFileSync } from 'node:fs';

// Whatever the config says, these never become cards: approvals, PIN and password change, settings (where both
// live), and anything carrying a record id (a ":param" or a digit-only segment) or leaving the portal.
const FORBIDDEN = /^\/(validations|settings)(\/|$)|pin|password/i;
const PLAIN_PATH = /^\/[a-z0-9\-/]*$/i;

function checkRoute(id, route) {
  const fail = (why) => { throw new Error(`navigate config: ${id}: ${why}`); };
  if (typeof route?.path !== 'string' || !PLAIN_PATH.test(route.path)) fail('path must be a plain portal path');
  if (route.path.startsWith('//')) fail('path must stay in the portal');
  if (FORBIDDEN.test(route.path)) fail('this page is never linked');
  if (route.path.split('/').some((segment) => /^\d+$/.test(segment))) fail('a path with a record id is never linked');
  if (!route.labels?.en || !route.labels?.fr) fail('labels are needed in English and French');
}

export function parseNavigation(config) {
  for (const [id, route] of Object.entries(config.routes ?? {})) checkRoute(id, route);
  if (!config.button?.en || !config.button?.fr) throw new Error('navigate config: button label is needed in English and French');
  return { button: config.button, routes: new Map(Object.entries(config.routes)) };
}

export const loadNavigation = (file) => parseNavigation(JSON.parse(readFileSync(file, 'utf8')));

const TAG = /\[\[navigate:([^\]]*)\]\]/gi;

// Takes every navigate tag out of a model reply. Only the first proposal counts.
export function parseNavigate(text) {
  const ids = [...text.matchAll(TAG)].map((m) => m[1].trim());
  return { proposal: ids[0] ?? null, text: text.replace(TAG, '').replace(/^\s+/, '') };
}

// Same fail-closed default the service uses when entitlements cannot be read: no package, not the primary connect.
const UNKNOWN = { packages: [], primaryConnect: false, audience: 'individual' };

// Why this customer may not be sent to the page, or null. `entitlements` is { packages, primaryConnect, audience };
// packages is null when the tenant does not use packages, otherwise the nature codes the customer has.
function refusalFor(route, entitlements) {
  const ent = entitlements ?? UNKNOWN;
  if (route.primaryOnly && !ent.primaryConnect) return 'primary_connect_only';
  if (route.audience && !route.audience.includes(ent.audience)) return 'not_for_audience';
  if (ent.packages && route.natures?.length && !route.natures.some((n) => ent.packages.includes(n))) return 'not_in_package';
  return null;
}

// The pages this customer may be offered, for the model's list. The same rules as validateProposal, so a page
// that would be dropped is not suggested in the first place.
export function offeredPages(navigation, language, entitlements) {
  return [...navigation.routes].filter(([, route]) => !refusalFor(route, entitlements))
    .map(([id, route]) => ({ id, label: route.labels[language] ?? route.labels.en }));
}

const cardOf = (navigation, id, route, language) => ({
  kind: 'navigate',
  target: id,
  path: route.path,
  label: route.labels[language] ?? route.labels.en,
  button: navigation.button[language] ?? navigation.button.en,
});

export function validateProposal(navigation, id, language, entitlements) {
  const route = navigation.routes.get(id);
  if (!route) return { ok: false, reason: 'unknown_action' };
  const reason = refusalFor(route, entitlements);
  return reason ? { ok: false, reason } : { ok: true, card: cardOf(navigation, id, route, language) };
}

// The "Steps" section of a guide (either language), used as written guidance when a proposal is dropped.
export function stepsOf(guideText) {
  const section = guideText.split(/^## /m).slice(1).find((s) => /^(steps|étapes)\s*$/i.test(s.split('\n')[0]));
  return section ? section.split('\n').slice(1).join('\n').trim() : '';
}
