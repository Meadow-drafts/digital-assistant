const EXACT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/-]{3,63}$/;
const REFERENCE_FIELDS = ['transId', 'ntrans'];
const HISTORY_REQUEST = /\b(?:history|transaction|transactions|historique|transaction|transactions)\b/i;
const PROHIBITED_DETAIL = /\b(?:status|details?|amount|balance|account|failed|success(?:ful)?|statut|d[eé]tails?|montant|solde|compte|[eé]chec|r[eé]ussi)\b/i;
const REFERENCE_VALUE = /\b[A-Za-z0-9][A-Za-z0-9._/-]{3,63}\b/g;

export function maskAgencyReferenceText(text) {
  return String(text).replace(REFERENCE_VALUE, (value) => /[A-Za-z]/.test(value) && /\d/.test(value) ? '[REFERENCE]' : value);
}

export function classifyAgencyHistoryQuestion(message) {
  if (!HISTORY_REQUEST.test(message)) return null;
  if (PROHIBITED_DETAIL.test(message)) return { kind: 'prohibited_detail' };
  const labeled = /\b(?:reference|ref|r[eé]f[eé]rence|id)\s*(?:is|est|[#:]\s*)?([A-Za-z0-9][A-Za-z0-9._/-]{3,63})/i.exec(message)?.[1];
  const bare = /^\s*([A-Za-z0-9][A-Za-z0-9._/-]{3,63})\s*[?!.]?\s*$/.exec(message)?.[1];
  return { kind: 'lookup', reference: labeled ?? bare ?? null };
}

// BICEC exposes one backend-scoped teller-history page. Search is deliberately
// local to that returned scope and exact: caller identities never enter the API.
export function createAgencyHistory({ gateway }) {
  return {
    async findExact({ tenant, token, reference }) {
      if (typeof reference !== 'string' || !EXACT_REFERENCE.test(reference) || !/[A-Za-z]/.test(reference) || !/[0-9]/.test(reference)) {
        return { kind: 'invalid_reference' };
      }
      let response;
      try {
        response = await gateway.request({
          tenant, token, method: 'GET', path: '/transactions/history/teller', query: { page: 0, limit: 100000 },
        });
      } catch { return { kind: 'unavailable' }; }
      if (!response || response.status !== 200) return { kind: 'unavailable' };
      const rows = response.body?.data?.content;
      if (!Array.isArray(rows)) return { kind: 'unavailable' };
      const found = rows.some((row) => REFERENCE_FIELDS.some((field) => typeof row?.[field] === 'string' && row[field] === reference));
      return { kind: found ? 'matched' : 'not_found' };
    },
  };
}
