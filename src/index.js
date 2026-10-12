import { createService } from './service.js';
import { createFileAudit } from './audit.js';

// Demo entry point: a scripted stand-in model so the host page works with no
// API key. The real OpenAI-compatible adapter arrives in a later ticket.
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
const port = Number(process.env.PORT ?? 3000);

createService({ model: scriptedModel, clock, audit }).listen(port, () => {
  console.log(`assistant demo host: http://localhost:${port}/`);
});
