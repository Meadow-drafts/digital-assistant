import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const LANGS = ['en', 'fr'];
const GUIDE_FILE = /^(.+)\.(en|fr)\.md$/;

const toPath = (dir) => (dir instanceof URL ? fileURLToPath(dir) : dir);

function pairProblems(dir) {
  const have = new Map();
  for (const file of readdirSync(dir)) {
    const m = GUIDE_FILE.exec(file);
    if (m) have.set(m[1], (have.get(m[1]) ?? new Set()).add(m[2]));
  }
  return [...have].flatMap(([id, langs]) => LANGS.filter((l) => !langs.has(l)).map((l) => `${id} (missing ${l})`));
}

// Ids of guides that exist in one language only, e.g. "refunds (missing fr)".
// Empty when every guide has its EN/FR pair. Run by CI through `npm test`.
export function checkGuidePairs(dirArg) {
  return pairProblems(toPath(dirArg));
}

function readGlossary(dir, lang) {
  const file = path.join(dir, `glossary.${lang}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

// Labels are injected by key ({{key}}) so steps quote the portal's real
// button and field names; an unknown key fails the load rather than shipping.
function inject(text, glossary, where) {
  return text.replace(/\{\{([\w.-]+)\}\}/g, (_, key) => {
    if (!(key in glossary)) throw new Error(`${where}: unknown glossary key ${key}`);
    return glossary[key];
  });
}

function frontmatter(raw) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) throw new Error('guide has no frontmatter');
  const meta = Object.fromEntries(m[1].split('\n').map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
  return { meta, body: m[2].trim() };
}

// "TRINC, TRINW (any one)" -> ['TRINC','TRINW']. Notes in parentheses are
// dropped; a line that is not purely package codes (e.g. "none", or
// "BALA/SOLDE for balance") does not gate the whole guide.
function packagesOf(line) {
  const codes = line.replace(/\([^)]*\)/g, '').trim();
  return /^[A-Z0-9][A-Z0-9, /]*$/.test(codes) ? codes.split(/[\s,/]+/).filter(Boolean) : null;
}

// The last section of every guide is "Talk to a human if", in either language.
function closingOf(body) {
  const sections = body.split(/^## /m);
  if (sections.length < 2) return null;
  const [heading, ...rest] = sections.at(-1).split('\n');
  return { heading: heading.trim(), body: rest.join('\n').trim() };
}

class GuideSet extends Map {
  constructor(entries, unsupported) {
    super(entries);
    this.unsupported = unsupported;
  }

  // Guides this customer may be told about. `entitlements` is
  // { packages, primaryConnect, audience }; null means unrestricted, and a
  // null `packages` means the customer's tenant does not use packages.
  availableFor(entitlements) {
    return [...this.values()].filter((g) => {
      if (!entitlements) return true;
      if (g.packages && entitlements.packages && !g.packages.some((p) => entitlements.packages.includes(p))) return false;
      if (g.primaryOnly && !entitlements.primaryConnect) return false;
      return g.roles.has(entitlements.audience);
    });
  }
}

export function loadGuides(dirArg) {
  const dir = toPath(dirArg);
  const problems = pairProblems(dir);
  if (problems.length) throw new Error(`guides missing a language: ${problems.join(', ')}`);

  const glossary = Object.fromEntries(LANGS.map((l) => [l, readGlossary(dir, l)]));
  const guides = new Map();
  for (const file of readdirSync(dir).sort()) {
    const m = GUIDE_FILE.exec(file);
    if (!m || m[2] !== 'en') continue;
    const id = m[1];
    const entry = { id };
    for (const lang of LANGS) {
      const { meta, body } = frontmatter(readFileSync(path.join(dir, `${id}.${lang}.md`), 'utf8'));
      if (meta.id !== id) throw new Error(`${id}.${lang}.md: frontmatter id is ${meta.id}`);
      const text = inject(body, glossary[lang], `${id}.${lang}.md`);
      entry[lang] = { title: /^# (.+)$/m.exec(text)?.[1] ?? id, text, closing: closingOf(text) };
      if (lang === 'en') {
        entry.packages = packagesOf(meta.package ?? '');
        entry.route = /^\/[A-Za-z0-9\-/]*/.exec(meta.route ?? '')?.[0] ?? null; // the first plain path, if the guide names one
        entry.primaryOnly = /\(primary connect only\)/.test(meta.audience ?? '');
        entry.roles = new Set((meta.audience ?? '').match(/individual|merchant/g) ?? []);
      }
    }
    guides.set(id, entry);
  }
  const unsupportedFile = path.join(dir, 'UNSUPPORTED.md');
  return new GuideSet(guides, existsSync(unsupportedFile) ? readFileSync(unsupportedFile, 'utf8') : '');
}
