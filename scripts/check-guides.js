import { checkGuidePairs } from '../src/guides.js';

const problems = checkGuidePairs(new URL('../guides/', import.meta.url));
if (problems.length) {
  console.error(`Guides missing a language: ${problems.join(', ')}`);
  process.exit(1);
}
console.log('All guides have EN and FR versions.');
