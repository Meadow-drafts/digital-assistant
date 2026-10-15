import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { createFakeGateway } from './harness/fake-gateway.js';
import { createFakeModel } from './harness/fake-model.js';
import { makeToken } from './harness/token.js';
import { chatTurn } from './harness/sse.js';
import { openWidget } from './harness/open-widget.js';
import { loadAgencyProfile } from '../src/profile.js';
import { loadGuides } from '../src/guides.js';
import { loadNavigation } from '../src/navigate.js';

const profile = loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url));
const guides = loadGuides(new URL('../guides-agency-bicec/', import.meta.url));
const navigation = loadNavigation(new URL('../config/agency-bicec/navigate-routes.json', import.meta.url));
const event = (events, type) => events.find((item) => item.type === type);

async function fixture(t) {
  const token = makeToken('agency-cash-workflow');
  const gateway = createFakeGateway({ 'GET /transactions/history/teller': { data: { content: [] } } });
  const model = createFakeModel((request) => request.purpose === 'route' ? '[]' : 'Follow the verified workflow steps.');
  const service = await startService({ agencyProfile: profile, gateway, model, guides, navigation });
  t.after(service.close);
  const started = await fetch(`${service.baseUrl}/session`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
  });
  return { ...service, token, session: await started.json() };
}

async function ask(service, message, language = 'en') {
  return chatTurn(service.baseUrl, { conversationId: service.session.conversationId, message, tenant: 'bicec-agency', language }, {
    token: service.token, headers: { 'x-assistant-session': service.session.sessionId },
  });
}

test('agency cash workflows are four distinct bilingual guides with matching portal links', () => {
  const expected = [
    ['private_cashin', '02-private-cashin', '/private'],
    ['private_cashout', '03-private-cashout', '/private'],
    ['gimac_cashin', '04-gimac-cashin', '/external'],
    ['gimac_cashout', '05-gimac-cashout', '/external'],
  ];
  for (const [routeId, guideId, path] of expected) {
    const guide = guides.get(guideId);
    assert.ok(guide, `missing ${guideId}`);
    assert.match(guide.en.text, /^# /);
    assert.match(guide.fr.text, /^# /);
    assert.equal(guide.route, path);
    assert.equal(guide.navigation, routeId);
    assert.ok(navigation.routes.has(routeId));
  }
});

test('agency guide answers hide the guide footer and “What I used” while keeping the Human-agent control', async (t) => {
  const service = await fixture(t);
  const widget = await openWidget(service.baseUrl, '/', { attrs: `tenant="bicec-agency" data-mode="agency" token="${service.token}"` });
  await widget.send('private cashin');
  await widget.until(() => widget.qa('message').some((message) => message.dataset.from === 'assistant'));
  const answer = widget.qa('message').filter((message) => message.dataset.from === 'assistant').map((message) => message.textContent).join('\n');
  assert.doesNotMatch(answer, /Talk to a human if|What I used|Ce que j'ai utilisé|Parlez à un agent si/i);
  assert.equal(widget.q('guides-used'), null);
  assert.ok(widget.q('human-chip'), 'the teller can still start an authorized human handoff');
  widget.dom.window.close();
});

for (const [phrase, language, options, linkTargets] of [
  ['cashin', 'en', ['Private Cash-in (Internal)', 'GIMAC Cash-in'], ['private_cashin', 'gimac_cashin']],
  ['cashout', 'en', ['Private Cash-out (Internal)', 'GIMAC Cash-out'], ['private_cashout', 'gimac_cashout']],
  ["cashin s'il vous plaît", 'fr', ['Cash-in privé (interne)', 'Cash-in GIMAC'], ['private_cashin', 'gimac_cashin']],
  ["cashout s'il vous plaît", 'fr', ['Cash-out privé (interne)', 'Cash-out GIMAC'], ['private_cashout', 'gimac_cashout']],
]) {
  test(`bare ${phrase} in ${language} explains both service types and links each workflow`, async (t) => {
    const service = await fixture(t);
    const { events } = await ask(service, phrase, language);
    assert.deepEqual(event(events, 'clarification').options, options);
    const explanation = event(events, 'delta').text;
    assert.match(explanation, /GIMAC/);
    assert.match(explanation, language === 'fr' ? /parcours local BICEC/i : /local BICEC route/i);
    assert.match(explanation, language === 'fr' ? /GIMAC.*CEMAC/i : /GIMAC.*CEMAC/i);
    assert.match(explanation, language === 'fr' ? /parcours prévu pour la destination/i : /route specified.*destination/i);
    assert.deepEqual(events.filter((item) => item.type === 'action_card').map((item) => item.target), linkTargets);
    assert.equal(service.model.calls.length, 0, 'the ambiguity is resolved without relying on model routing');
  });
}

for (const [phrase, guideId, target] of [
  ['private cashin', '02-private-cashin', 'private_cashin'],
  ['internal cashin', '02-private-cashin', 'private_cashin'],
  ['private cashout', '03-private-cashout', 'private_cashout'],
  ['internal cashout', '03-private-cashout', 'private_cashout'],
  ['GIMAC cashin', '04-gimac-cashin', 'gimac_cashin'],
  ['GIMAC cashout', '05-gimac-cashout', 'gimac_cashout'],
]) {
  test(`explicit agency request “${phrase}” selects its matching guide and link`, async (t) => {
    const service = await fixture(t);
    const { events } = await ask(service, phrase);
    assert.equal(event(events, 'clarification'), undefined);
    assert.deepEqual(event(events, 'guides').guides, [], 'agency answers do not expose the “What I used” guide chip data');
    assert.deepEqual(service.audit.records.at(-1).guideIds, [guideId], 'the used guide remains in the internal audit record');
    assert.equal(event(events, 'action_card').target, target);
  });
}
