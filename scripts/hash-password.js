import { hashPassword } from '../src/password.js';

// Prints the hash to put in config/support.json as an agent's "password". The password is read from standard input
// (not from the command line, which shells keep in history): echo -n 'the password' | node scripts/hash-password.js
let input = '';
for await (const chunk of process.stdin) input += chunk;
const password = input.replace(/\r?\n$/, '');
if (!password) { console.error('Give the password on standard input.'); process.exit(1); }
console.log(hashPassword(password));
