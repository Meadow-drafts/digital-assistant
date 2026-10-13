// Fixtures shaped like the Spring Boot responses (clientInfo, bipay-recent,
// history/transactions, plafond/montant), one bank customer per call.
import { createHash } from 'node:crypto';
import { makeToken } from './token.js';

export const sha512 = (text) => createHash('sha512').update(text).digest('hex');

// `siblings` are other wallets under the same client; the connects list returns them with personal details.
export function customer({ sub, cli, accountNo, phone, rows = [], primaryConnect = true, siblings = [], pin = '1234', balance = { ledger: 912345, available: 845678 }, pinAttempts = 3 }) {
  return { sub, cli, accountNo, phone, rows, primaryConnect, siblings, pin, balance, pinAttempts, token: makeToken(sub) };
}

export const connectRow = (c) => ({
  etab: '001', codewal: c.sub, cli: c.cli, tel: c.phone, ema: `${c.sub}@mail.test`, nom: `NAME OF ${c.sub}`, npid: `ID${c.sub}`,
  primaryConnect: c.primaryConnect, showSolde: true,
});

export const row = (c, over = {}) => ({
  ntrans: 'N0001',
  clientReferenceId: 'REF-0001',
  mtrans: 15000,
  dev: 'XAF',
  dop: '2026-10-10T09:30:00.000+00:00',
  top: 'TRANSFER',
  nat: 'TRINC',
  sta: '01',
  codewaldo: c.sub,
  codewalop: '237677000999',
  teldo: c.phone,
  telop: '237677000999',
  partnerlib: 'Jean Paul Mbarga',
  dcpt: c.accountNo,
  ccpt: '98765432109',
  ...over,
});

// Routes for createFakeGateway covering every customer by their own token.
export function bankRoutes(customers, { limits = [], nomenclature = null } = {}) {
  const who = (token) => customers.find((c) => c.token === token);
  // like the real endpoint, lists every wallet under the cli, with personal details, for any valid token
  const connects = Object.fromEntries(customers.map((c) => [
    `GET /digitalbank/clients/connects/accounts/${c.cli}`,
    ({ token }) => (who(token) ? { data: [connectRow(c), ...c.siblings], success: '01', status: '01' } : { status: 401, body: null }),
  ]));
  return {
    ...connects,
    // like the real endpoint, answers for whatever account number the body names; no PIN check on the server
    'POST /digitalbank/getSolde': ({ token, body }) => {
      if (!who(token)) return { status: 401, body: null };
      const target = customers.find((x) => x.accountNo === body?.cpt);
      return target ? { success: '01', solde: { accountBalance: target.balance.ledger, availableBalance: target.balance.available } } : { success: '02' };
    },
    // like the real endpoint: success 01 ok, 02 wrong (data = attempts left), 101 blocked; trusts the tel in the body
    'POST /digitalbank/checkPin': ({ token, body }) => {
      if (!who(token)) return { status: 401, body: null };
      const target = customers.find((x) => x.sub === body?.tel);
      if (!target || target.pinAttempts <= 0) return { success: '101', message: 'blocked' };
      if (body.pin === sha512(target.pin)) return { success: '01' };
      target.pinAttempts -= 1;
      return target.pinAttempts <= 0 ? { success: '101', message: 'blocked' } : { success: '02', data: String(target.pinAttempts) };
    },
    // like the real endpoint, answers for whatever cli the body names, whoever the token belongs to
    'POST /digitalbank/clientInfo': ({ token, body }) => {
      if (!who(token)) return { status: 401, body: null };
      const target = customers.find((x) => x.cli === body?.cli);
      if (!target) return { success: '02', data: null };
      return {
        success: '01',
        data: {
          cli: target.cli, name: `NAME OF ${target.sub}`, email: `${target.sub}@mail.test`, telephones: [target.phone], age: '00001',
          accounts: [{
            accountNo: target.accountNo, age: '00001', cle: '55', genre: '10', dev: 'XAF', cli: target.cli, name: `ACCOUNT HOLDER ${target.sub}`, inti: `INTITULE ${target.sub}`,
            accountBalance: 4242001, availableBalance: 4242002, soldeDispo: 4242003, historyBalance: 4242004, indicativeBalance: 4242005,
            sde: '4242006', sin: '4242007', attached: false, principal: true,
          }],
        },
      };
    },
    // like the real endpoint, answers for whatever wallet the body names
    'POST /digitalbank/history/bipay-recent': ({ token, body }) => {
      if (!who(token)) return { status: 401, body: null };
      const owner = customers.find((c) => c.sub === body?.codewaldo);
      return { status: '01', statut: '01', data: owner ? owner.rows : [] };
    },
    // like the real endpoint, looks the reference up across everyone's transactions
    'GET /digitalbank/history/transactions': ({ token, query }) => {
      if (!who(token)) return { status: 401, body: null };
      const found = customers.flatMap((c) => c.rows).find((r) => r.clientReferenceId === query?.clientRefId || r.ntrans === query?.clientRefId);
      return found ? { success: '01', status: '01', data: found } : { success: '02', status: '02', message: 'Transaction not found' };
    },
    // Shared reference data (the portal's nomenclature 6000, nature labels). Absent unless a test supplies it.
    'GET /iwomicore/getNomenDataByTabcd/6000': ({ token }) => (!who(token) ? { status: 401, body: null } : nomenclature ? { data: nomenclature } : { status: 404, body: null }),
    'GET /digitalbank/plafond/montant': ({ token }) => (who(token) ? limits : { status: 401, body: null }),
  };
}
