import { maskText } from './mask.js';
import { shield } from './shield.js';

const EXACT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/-]{3,63}$/;
const REFERENCE_FIELDS = ['transId', 'ntrans'];
const HISTORY_REQUEST = /\b(?:history|transaction|transactions|historique|transaction|transactions)\b/i;
const REFERENCE_VALUE = /\b[A-Za-z0-9][A-Za-z0-9._/-]{3,63}\b/g;

const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const maskIdentifier = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? `****${digits.slice(-4)}` : value ? '[REFERENCE]' : null;
};
const maskedText = (value) => value == null ? null : maskText(shield(String(value)).text).slice(0, 240);
const number = (value) => Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null;

export function maskAgencyReferenceText(text) {
  return String(text).replace(REFERENCE_VALUE, (value) => /[A-Za-z]/.test(value) && /\d/.test(value) ? '[REFERENCE]' : value);
}

export function classifyAgencyHistoryQuestion(message) {
  if (!HISTORY_REQUEST.test(message)) return null;
  const labeled = /\b(?:reference|ref|r[eé]f[eé]rence|id)\s*(?:is|est|[#:]\s*)?([A-Za-z0-9][A-Za-z0-9._/-]{3,63})|\btransaction\s+(?:reference\s*[:#]?\s*)?([A-Za-z0-9][A-Za-z0-9._/-]{3,63})/i.exec(message);
  const bare = /^\s*([A-Za-z0-9][A-Za-z0-9._/-]{3,63})\s*[?!.]?\s*$/.exec(message)?.[1];
  const candidate = labeled?.[1] ?? labeled?.[2] ?? bare ?? null;
  const reference = candidate && /[A-Za-z]/.test(candidate) && /\d/.test(candidate) ? candidate : null;
  return { kind: 'lookup', reference };
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
      const row = rows.find((candidate) => REFERENCE_FIELDS.some((field) => typeof candidate?.[field] === 'string' && candidate[field] === reference));
      if (!row) return { kind: 'not_found' };
      const fees = row.qoutePart?.feesResponse;
      const feeTotal = number(fees?.fees) === null || number(fees?.tva) === null ? null : number(fees.fees) + number(fees.tva);
      const destination = row.top === 'RSCA' ? row.telop : row.receiverAcc || row.codewalop;
      const partnerId = maskIdentifier(row.partnerid);
      const failureReason = String(row.status ?? '').toUpperCase() === 'FAILED'
        ? [row.msgCode ? `CODE: ${text(String(row.msgCode))}.` : null, maskedText(row.msg)].filter(Boolean).join(' ') || null
        : null;
      return {
        kind: 'matched',
        transaction: {
          date: text(row.createdAt),
          id: maskIdentifier(row.transId ?? row.ntrans),
          from: maskIdentifier(row.issuerAcc),
          to: maskIdentifier(destination),
          member: [text(row.partnerlib), partnerId ? `[${partnerId}]` : null].filter(Boolean).join(' ') || null,
          service: text(row.top),
          type: text(row.operationType),
          amount: number(row.amount),
          fees: feeTotal,
          reason: maskedText(row.reason),
          status: text(row.status),
          failureReason,
        },
      };
    },
  };
}
