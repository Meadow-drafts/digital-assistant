import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGuides } from '../src/guides.js';
import { loadAgencyProfile } from '../src/profile.js';
import { loadNavigation } from '../src/navigate.js';

const profile = loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url));
const guides = () => loadGuides(new URL(`../${profile.guidesDirectory}/`, import.meta.url));

test('BICEC teller workflows have bilingual approved guides and cash-in is first', () => {
  const all = guides();
  const expected = [
    '00-cash-in', '01-cash-out', '02-private-cashin', '03-private-cashout', '04-gimac-cashin',
    '04-voucher-generation', '05-gimac-cashout', '05-voucher-cancellation', '06-cardless-withdrawal',
    '07-merchant-payment-vouchers', '08-incoming-remittance', '09-outgoing-remittance',
    '10-bill-payment', '11-airtime', '12-internet', '13-merchant-services', '14-validations',
  ];
  assert.deepEqual([...all.keys()], expected);
  for (const guide of all.values()) {
    assert.equal(guide.customerCatalogue, true);
    assert.doesNotMatch(guide.en.title, /DRAFT/i);
    assert.doesNotMatch(guide.fr.title, /BROUILLON/i);
    assert.doesNotMatch(guide.en.text, /not bank-approved/i);
    assert.doesNotMatch(guide.fr.text, /ne s’agit pas d’une procédure approuvée/i);
    assert.match(guide.en.text, /never asks for your PIN, OTP/i);
    assert.match(guide.fr.text, /ne demande jamais votre PIN, OTP/i);
    assert.match(guide.en.text, /^## When to use$/m, `${guide.id} needs a use case`);
    assert.match(guide.fr.text, /^## Quand l’utiliser$/m, `${guide.id} needs a French use case`);
    assert.match(guide.en.text, /^## Steps$/m, `${guide.id} needs steps`);
    assert.match(guide.fr.text, /^## Étapes$/m, `${guide.id} needs French steps`);
    assert.match(guide.en.text, /^## Common errors$/m, `${guide.id} needs troubleshooting`);
    assert.match(guide.fr.text, /^## Erreurs fréquentes$/m, `${guide.id} needs French troubleshooting`);
  }
});

test('approved teller guides defer unverified policy and keep workflow actions with the teller', () => {
  const all = guides();
  const combined = [...all.values()].map((guide) => `${guide.en.text}\n${guide.fr.text}`).join('\n');
  assert.match(combined, /fees, limits, eligibility, corridors, or exceptions/i);
  assert.match(combined, /frais, plafonds, critères d’éligibilité, corridors ou exceptions/i);
  assert.match(all.get('14-validations').en.text, /does not recommend whether to approve or reject/i);
  assert.match(all.get('14-validations').fr.text, /ne recommande pas d’approuver ou de rejeter/i);
  assert.equal([...all.values()].some((g) => /\[\[navigate:/i.test(g.en.text)), false);
});

test('each BICEC workflow with a safe portal destination has an allowlisted route in English and French', () => {
  const all = guides();
  const navigation = loadNavigation(new URL('../config/agency-bicec/navigate-routes.json', import.meta.url));
  for (const guide of all.values()) {
    assert.ok(guide.route, `${guide.id} needs a fixed portal route`);
    assert.ok([...navigation.routes.values()].some((route) => route.path === guide.route), `${guide.id} route must be allowlisted`);
  }
  assert.equal([...navigation.routes.values()].every((route) => route.labels.en && route.labels.fr && route.cta.en && route.cta.fr), true);
  assert.equal(navigation.routes.get('validations')?.navigationPurpose, 'review', 'the validation link only opens the teller review page');
});

test('French workflow guides quote the portal labels recorded in its translation resources', () => {
  const all = guides();
  assert.match(all.get('02-private-cashin').fr.text, /Cashin - Cashout Interne/);
  assert.match(all.get('03-private-cashout').fr.text, /Cashin - Cashout Interne/);
  assert.match(all.get('04-gimac-cashin').fr.text, /Cashin - Cashout GIMAC/);
  assert.match(all.get('05-gimac-cashout').fr.text, /Cashin - Cashout GIMAC/);
  assert.match(all.get('04-voucher-generation').fr.text, /Générer un code voucher/);
  assert.match(all.get('06-cardless-withdrawal').fr.text, /Retrait sans carte/);
  assert.match(all.get('07-merchant-payment-vouchers').fr.text, /Voucher Paiement Marchand/);
  assert.match(all.get('09-outgoing-remittance').fr.text, /Envoi sortant/);
  assert.match(all.get('11-airtime').fr.text, /Recharge de crédit/);
  assert.match(all.get('12-internet').fr.text, /Recharge Internet/);
});
