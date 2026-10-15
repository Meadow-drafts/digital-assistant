import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGuides } from '../src/guides.js';
import { loadAgencyProfile } from '../src/profile.js';

const profile = loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url));
const guides = () => loadGuides(new URL(`../${profile.guidesDirectory}/`, import.meta.url));

test('BICEC teller workflows have bilingual approved guides and cash-in is first', () => {
  const all = guides();
  const expected = [
    '00-cash-in', '01-cash-out', '02-private-cash-services', '03-gimac-cash-services',
    '04-voucher-generation', '05-voucher-cancellation', '06-cardless-withdrawal',
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
    assert.match(guide.en.text, /never asks for your PIN or OTP/i);
    assert.match(guide.fr.text, /ne demande jamais votre PIN ou OTP/i);
  }
});

test('approved teller guides defer unverified policy and keep workflow actions with the teller', () => {
  const all = guides();
  const combined = [...all.values()].map((guide) => `${guide.en.text}\n${guide.fr.text}`).join('\n');
  assert.match(combined, /fees, limits, eligibility, corridors and exceptions/i);
  assert.match(combined, /frais, plafonds, critères d’éligibilité, corridors et exceptions/i);
  assert.match(all.get('14-validations').en.text, /never recommends an approval decision/i);
  assert.match(all.get('14-validations').fr.text, /ne recommande jamais et ne prend aucune décision d’approbation/i);
  assert.equal([...all.values()].some((g) => /\[\[navigate:/i.test(g.en.text)), false);
});

test('French workflow guides quote the portal labels recorded in its translation resources', () => {
  const all = guides();
  assert.match(all.get('02-private-cash-services').fr.text, /Cashin - Cashout Interne/);
  assert.match(all.get('03-gimac-cash-services').fr.text, /Cashin - Cashout GIMAC/);
  assert.match(all.get('04-voucher-generation').fr.text, /Générer un code voucher/);
  assert.match(all.get('06-cardless-withdrawal').fr.text, /Retrait sans carte/);
  assert.match(all.get('07-merchant-payment-vouchers').fr.text, /Voucher Paiement Marchand/);
  assert.match(all.get('09-outgoing-remittance').fr.text, /Envoi sortant/);
  assert.match(all.get('11-airtime').fr.text, /Recharge de crédit/);
  assert.match(all.get('12-internet').fr.text, /Recharge Internet/);
});
