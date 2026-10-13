import { createService } from './service.js';
import { createFileAudit } from './audit.js';
import { createModel, loadModelConfig } from './model.js';
import { loadGuides } from './guides.js';
import { loadNavigation } from './navigate.js';
import { loadPrefill } from './prefill.js';
import { loadLimits } from './limits.js';
import { loadScamCues } from './scam.js';
import { loadSupport } from './support.js';
import { createMailer } from './mailer.js';
import { loadRetention } from './retention.js';
import { createHttpGateway, loadTenants } from './gateway.js';
import { assertStartup } from './startup.js';

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
const outputAllowlist = { urlHosts: list('OUTPUT_ALLOW_URL_HOSTS'), emails: list('OUTPUT_ALLOW_EMAILS'), phones: list('OUTPUT_ALLOW_PHONES') };
// Pages the assistant may offer as cards; the bank edits this file when the portal's routes change.
const navigation = loadNavigation(process.env.NAVIGATE_ROUTES ?? new URL('../config/navigate-routes.json', import.meta.url));
// Which fields the assistant may pre-fill on each form, and the double-check thresholds (placeholders until the bank sets them).
const prefill = loadPrefill(process.env.PREFILL_REGISTRY ?? new URL('../config/prefill.json', import.meta.url), navigation);
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
createService({ devPage, model: modelConfig ? createModel(modelConfig) : scriptedModel, gateway, clock, audit, guides, navigation, prefill, scamCues, failedQuestions, outputAllowlist, limits: loadLimits(process.env), mailer, agents, support, consoleUrl, retention }).listen(port, () => {
  console.log(`assistant demo host: http://localhost:${port}/`);
});
