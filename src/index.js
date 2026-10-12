import { createService } from './service.js';
import { createFileAudit } from './audit.js';
import { createModel, loadModelConfig } from './model.js';
import { loadGuides } from './guides.js';
import { loadLimits } from './limits.js';

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

const clock = { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id) };
const audit = createFileAudit(process.env.AUDIT_LOG ?? 'data/audit.jsonl');
const failedQuestions = createFileAudit(process.env.FAILED_QUESTIONS_LOG ?? 'data/failed-questions.jsonl');
const guides = loadGuides(new URL('../guides/', import.meta.url));
// Output allowlist: comma-separated OUTPUT_ALLOW_URL_HOSTS / _EMAILS / _PHONES. Empty blocks everything.
const list = (name) => (process.env[name] ?? '').split(',').map((v) => v.trim()).filter(Boolean);
const outputAllowlist = { urlHosts: list('OUTPUT_ALLOW_URL_HOSTS'), emails: list('OUTPUT_ALLOW_EMAILS'), phones: list('OUTPUT_ALLOW_PHONES') };
const port = Number(process.env.PORT ?? 3000);

const modelConfig = loadModelConfig(process.env);
createService({ model: modelConfig ? createModel(modelConfig) : scriptedModel, clock, audit, guides, failedQuestions, outputAllowlist, limits: loadLimits(process.env) }).listen(port, () => {
  console.log(`assistant demo host: http://localhost:${port}/`);
});
