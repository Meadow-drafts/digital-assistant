// Rules-based EN/FR detector, run per message. Accent-free, misspelled and
// mixed text is expected, so it scores common function words and accents rather
// than trusting any single signal. Ties keep the previous language, else 'en'.
const FR = new Set(('le la les un une des du de au aux et ou est sont je j ai jai tu il elle nous vous ils ne pas pour par sur avec dans ' +
  'mon ma mes ton ta son sa ses notre votre mais que qui quoi comment ou quand pourquoi combien ce cet cette ces ' +
  'faire fait veux peux puis dois recu recus merci bonjour salut svp compte virement argent solde facture ' +
  'envoyer payer pas ete etre avoir cest').split(' '));
const EN = new Set(('the a an and or is are am i you he she we they not for by on with in my your our his her their but that who what how ' +
  'where when why which this these those do does did can could would should will want need have has had send pay ' +
  'to of it its me please thanks thank hello hi money account transfer bill balance').split(' '));

export function detectLanguage(text, previous = 'en') {
  const words = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z]+/g) ?? [];
  let fr = (text.match(/[àâçéèêëîïôùûüœ]/gi) ?? []).length;
  let en = 0;
  for (const w of words) {
    if (FR.has(w)) fr++;
    if (EN.has(w)) en++;
  }
  if (fr === en) return previous;
  return fr > en ? 'fr' : 'en';
}
