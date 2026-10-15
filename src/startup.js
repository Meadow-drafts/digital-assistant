import { isHashed } from './password.js';

// Start-up gate (ticket 35). Demo and production are separate modes, chosen by ASSISTANT_MODE (default "demo").
// Demo needs none of the prerequisites below. Production refuses to start unless every one is met, and the error
// names each one that is not, so a demo configuration cannot become production by accident.
export class StartupError extends Error {
  constructor(problems) {
    super(`Cannot start in production mode. ${problems.length} prerequisite${problems.length === 1 ? ' is' : 's are'} not met:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'StartupError';
    this.problems = problems;
  }
}

// Models used for the demo (ticket 12, 15), matched as lower-case substrings of the configured model name.
const DEMO_MODELS = ['qwen3.8', 'gpt-oss', 'qwen2.5'];
const isDemoModel = (name) => DEMO_MODELS.some((m) => String(name).toLowerCase().includes(m));
const PLACEHOLDER_DOMAIN = /@example\.test$/i;
const LOCAL_HOST = /^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0)/i;

export function assertStartup({ env, support, modelConfig, tenants = {} }) {
  const mode = env.ASSISTANT_MODE ?? 'demo';
  if (mode === 'demo') return mode;
  if (mode !== 'production') throw new Error(`ASSISTANT_MODE must be "demo" or "production", got "${mode}"`);

  const problems = [];

  if (env.COMPLIANCE_AGREEMENT_CONFIRMED !== 'true') {
    problems.push('proof of the bank\'s compliance agreement: set COMPLIANCE_AGREEMENT_CONFIRMED=true once the owner holds it');
  }

  if (!modelConfig) {
    problems.push('a production model: set MODEL_PRIMARY_BASE_URL and MODEL_PRIMARY_NAME (the scripted stand-in is demo only)');
  } else {
    for (const role of ['primary', 'fallback']) {
      if (modelConfig[role] && isDemoModel(modelConfig[role].model)) {
        problems.push(`a production model: the ${role} model "${modelConfig[role].model}" is a demo model, choose the bank's production model`);
      }
    }
    if (modelConfig.offline) problems.push('no offline model: MODEL_OFFLINE_* is the local demo fallback and must not be set in production');
  }

  if (!env.TOKEN_SCOPE?.trim()) {
    problems.push('a scoped token setting: set TOKEN_SCOPE to the scope of the read-only token the backend owner issues');
  }

  const days = Number(env.RETENTION_DAYS);
  if (env.RETENTION_DAYS === undefined || env.RETENTION_DAYS === '' || !Number.isFinite(days) || days <= 0) {
    problems.push('a real retention value: set RETENTION_DAYS (positive days) from the bank\'s compliance answer; the 30-day file value is a placeholder');
  }

  const agents = support.agents.list;
  const plainAgents = agents.filter((a) => !isHashed(a.password) && !/^change-me/i.test(a.password));
  if (plainAgents.length) {
    problems.push(`hashed agent passwords: ${plainAgents.map((a) => a.id).join(', ')} hold a plain-text password; store the output of "node scripts/hash-password.js" instead`);
  }
  const demoAgents = agents.filter((a) => /^change-me/i.test(a.password) || PLACEHOLDER_DOMAIN.test(a.email));
  if (!agents.length || demoAgents.length) {
    problems.push(`real agent logins: ${agents.length ? `config/support.json still has demo logins (${demoAgents.map((a) => a.id).join(', ')})` : 'no agents are configured'}`);
  }

  const mail = support.mail;
  if (!mail.supportAddress || PLACEHOLDER_DOMAIN.test(mail.supportAddress)) {
    problems.push('a support email: mail.supportAddress is missing or still the placeholder');
  }
  if (mail.mode !== 'smtp' || !mail.smtp?.host || LOCAL_HOST.test(mail.smtp.host) || PLACEHOLDER_DOMAIN.test(mail.from ?? '') || !mail.from) {
    problems.push('a real mailer: mail.mode must be "smtp" to a real server (not localhost), with a real mail.from sender');
  }

  const testServers = Object.entries(tenants).filter(([, value]) => /bipay-test/i.test(typeof value === 'string' ? value : value?.baseUrl ?? ''));
  if (testServers.length) {
    problems.push(`a production gateway: tenant ${testServers.map(([id]) => `"${id}"`).join(', ')} in the gateway allowlist points at the test server (bipay-test)`);
  }
  const insecureGateways = Object.entries(tenants).filter(([, value]) => /^http:\/\//i.test(typeof value === 'string' ? value : value?.baseUrl ?? ''));
  if (insecureGateways.length) {
    problems.push(`HTTPS gateway origins: tenant ${insecureGateways.map(([id]) => `"${id}"`).join(', ')} uses HTTP, which does not protect the forwarded teller token`);
  }

  for (const name of ['TEST_TOKEN', 'TEST_CLI', 'TEST_PORTAL_FLAG']) {
    if (env[name]) problems.push(`no dev-only ${name}: unset it (the demo page carries a real token)`);
  }

  const serviceKeys = Object.keys(env).filter((k) => /api[-_]?uuid/i.test(k));
  if (serviceKeys.length) {
    problems.push(`no X-API-UUID service key: unset ${serviceKeys.join(', ')} (the assistant only forwards the logged-in user's own token)`);
  }

  if (problems.length) throw new StartupError(problems);
  return mode;
}
