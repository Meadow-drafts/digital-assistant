import { runReplay } from './run.js';

try {
  const report = await runReplay();
  console.log(`\nReplay complete: ${report.scenarios} scenarios, ${report.turns} turns (${report.languages.join(', ')}).`);
} catch (error) {
  console.error(`Replay failed: ${error.message}`);
  process.exitCode = 1;
}
