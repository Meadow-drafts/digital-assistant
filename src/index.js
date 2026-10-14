import { createService } from './service.js';
import { createFileAudit } from './audit.js';
import { createModel, loadModelConfig } from './model.js';
import { loadGuides } from './guides.js';
import { loadNavigation } from './navigate.js';
import { loadLimits } from './limits.js';
import { loadScamCues } from './scam.js';
import { loadSupport } from './support.js';
import { createMailer } from './mailer.js';
import { loadRetention } from './retention.js';
import { createHttpGateway, loadTenants } from './gateway.js';
import { assertStartup } from './startup.js';
import { loadSessionSecret, openDatabase } from './database.js';

// Demo entry point. With MODEL_PRIMARY_* set in the environment (see
// loadModelConfig) the real OpenAI-compatible chain is used; otherwise a
// scripted stand-in lets the host page work with no API key.
const scriptedModel = {
  name: 'scripted-demo',
  async *chat({ language }) {
    const reply = language === 'fr'
      ? "Ceci est une réponse de démonstration. Le vrai assistant répondra ici avec les étapes exactes du portail."
      : 'This is a demo reply. The real assistant will answer here with the exact portal steps.';
    for (const word of reply.split(/(?<= )/)) {
      await new Promise((r) => setTimeout(r, 40));
      yield word;
    }
  },
};

// Support configuration (tickets 28-29): the agent roster and who is on call, opening hours, every timer, and how
// mail is sent. One file, placeholder values from ticket 07; SUPPORT_CONFIG points at another file. Demo passwords
// live in that file in plain text; the production gate refuses them.
// Mode gate (ticket 35, below): ASSISTANT_MODE=production refuses to start unless every prerequisite is met; demo
// needs none. It runs before anything is opened or created.
const support = loadSupport(process.env.SUPPORT_CONFIG ?? new URL('../config/support.json', import.meta.url));
const modelConfig = loadModelConfig(process.env);
// Gateway base URLs come only from this tenant-id allowlist (demo entry: the bank's test server).
const tenants = loadTenants(process.env.GATEWAY_TENANTS ?? new URL('../config/tenants.json', import.meta.url));
let mode;
try { mode = assertStartup({ env: process.env, support, modelConfig, tenants }); } catch (e) { console.error(e.message); process.exit(1); }
console.log(`mode: ${mode}`);

const clock = { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id) };
const audit = createFileAudit(process.env.AUDIT_LOG ?? 'data/audit.jsonl');
const failedQuestions = createFileAudit(process.env.FAILED_QUESTIONS_LOG ?? 'data/failed-questions.jsonl');
const guides = loadGuides(new URL('../guides/', import.meta.url));
// Output allowlist: comma-separated OUTPUT_ALLOW_URL_HOSTS / _EMAILS / _PHONES. Empty blocks everything.
const list = (name) => (process.env[name] ?? '').split(',').map((v) => v.trim()).filter(Boolean);
// Origins allowed to call the service from a browser page (the portal hosting the widget), exact and comma-separated,
// for example ALLOWED_ORIGINS=http://localhost:3001. Empty means same-origin only. A wildcard or a path is refused.
const allowedOrigins = list('ALLOWED_ORIGINS');
for (const o of allowedOrigins) {
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(o)) { console.error(`ALLOWED_ORIGINS: "${o}" is not an exact origin like http://localhost:3001`); process.exit(1); }
}
const outputAllowlist = { urlHosts: list('OUTPUT_ALLOW_URL_HOSTS'), emails: list('OUTPUT_ALLOW_EMAILS'), phones: list('OUTPUT_ALLOW_PHONES') };
// Pages the assistant may offer as cards; the bank edits this file when the portal's routes change.
const navigation = loadNavigation(process.env.NAVIGATE_ROUTES ?? new URL('../config/navigate-routes.json', import.meta.url));
// Form pre-fill is switched off: a request to do a task gets a "Click here" link to the page and the guide's steps, and the
// customer fills the form themselves. (The pre-fill code and config/prefill.json stay in the repo, unused.)
const port = Number(process.env.PORT ?? 3000);
const agents = support.agents;
const consoleUrl = process.env.CONSOLE_URL ?? `http://localhost:${port}/console`;
// Log-only by default (free, sends nothing). mail.mode "smtp" in the support config hands mail to a local dev mail
// catcher such as Mailpit on localhost:1025; a real SMTP server is a setting that stays off.
const mailer = createMailer(support.mail);

// One retention value for transcripts and audit (placeholder 30 days; RETENTION_DAYS overrides the file).
const retention = loadRetention(process.env.RETENTION_CONFIG ?? new URL('../config/retention.json', import.meta.url));

const scamCues = loadScamCues(process.env.SCAM_CUES ?? new URL('../config/scam-cues.json', import.meta.url));
const gateway = createHttpGateway({ tenants });
// Dev only: TEST_TOKEN and TEST_CLI (a test customer's bearer token and cli) go on the demo page so a session can start.
const devPage = process.env.TEST_TOKEN && process.env.TEST_CLI ? { token: process.env.TEST_TOKEN, cli: process.env.TEST_CLI, portalFlag: process.env.TEST_PORTAL_FLAG === '1' } : undefined;
if (devPage) console.warn('TEST_TOKEN/TEST_CLI set: the demo page carries a real token. Local use only.');
// Signed customer session ids (ticket 38). The signing key is SESSION_SECRET (16+ characters), or else a key made once and kept in
// data/session-secret (owner-only), so customers stay signed in across a restart. SESSION_TTL_HOURS (default 8) is the longest
// a session lasts; a token that expires sooner ends it sooner.
function sessionConfig() {
  const hours = process.env.SESSION_TTL_HOURS === undefined ? 8 : Number(process.env.SESSION_TTL_HOURS);
  if (!Number.isFinite(hours) || hours <= 0) { console.error('SESSION_TTL_HOURS must be a positive number'); process.exit(1); }
  try { return { sessionSecret: loadSessionSecret(process.env.SESSION_SECRET_FILE ?? 'data/session-secret'), sessionTtlMs: hours * 60 * 60_000 }; } catch (e) { console.error(e.message); process.exit(1); }
}
// Cases and conversations are kept in SQLite (ticket 62), by default data/assistant.db (DATABASE_FILE). The file holds only
// text the service already keeps masked; it is git-ignored and covered by the one retention value.
let database;
try { database = openDatabase(process.env.DATABASE_FILE ?? 'data/assistant.db'); } catch (e) { console.error(`database: ${e.message}`); process.exit(1); }
const server = createService({ allowedOrigins, devPage, model: modelConfig ? createModel(modelConfig) : scriptedModel, gateway, clock, audit, guides, navigation, scamCues, failedQuestions, outputAllowlist, limits: loadLimits(process.env), mailer, agents, support, consoleUrl, retention, database, ...sessionConfig() });
server.listen(port, () => {
  console.log(`assistant demo host: http://localhost:${port}/`);
  console.log(`storage: ${process.env.DATABASE_FILE ?? 'data/assistant.db'}`);
});
// A stop writes what is pending and closes the database, so nothing is lost between a change and the next write.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => { try { database.close(); } catch { /* already closed */ } process.exit(0); });
    server.closeAllConnections?.();
  });
}
