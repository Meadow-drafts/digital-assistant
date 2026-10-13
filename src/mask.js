// Masking for free text that reaches a human (the console transcript). Account and phone numbers become
// ****NNNN (last four digits), the same shape as elsewhere. Amounts, dates (8 digits at most) and short
// references stay readable. Names typed in free text cannot be recognised and are not touched here; names
// that come from the bank's data are already reduced to initials before they get this far.
// Digits glued to a letter or digit before them (a reference such as FT2610123456) are part of a longer id, not a number.
const LONG_NUMBER = /(?<![A-Za-z0-9])\+?\d(?:[ .-]?\d){8,}/g;

export function maskText(text) {
  return String(text).replace(LONG_NUMBER, (run) => `****${run.replace(/\D/g, '').slice(-4)}`);
}
