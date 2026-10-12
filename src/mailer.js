import net from 'node:net';
import tls from 'node:tls';

// Sends the service's emails. Two modes, both from config/support.json:
//   log   (default): nothing is sent; the recipient and subject are logged, never the body. Costs nothing.
//   smtp: hands the message to an SMTP server. Point it at a local dev mail catcher (Mailpit/MailHog on port 1025)
//         for the demo. A real SMTP server (secure: true = implicit TLS, optional user/password) is a setting
//         that stays off until the bank provides one.
const ADDRESS = /^[^\s<>,;"\r\n]+@[^\s<>,;"\r\n]+$/;
const oneLine = (v) => String(v).replace(/[\r\n]+/g, ' ');

export function createMailer(config, { log = (line) => console.log(line) } = {}) {
  if (config.mode !== 'smtp') {
    return { async send({ to, subject }) { log(`[mail not sent: log-only mailer] to ${oneLine(to)}: ${oneLine(subject)}`); } };
  }
  const { host, port, secure = false, user = null, password = null } = config.smtp ?? {};

  async function send({ to, subject, body }) {
    if (!ADDRESS.test(to)) throw new Error('mail: bad recipient');
    if (!ADDRESS.test(config.from ?? '')) throw new Error('mail: bad sender');
    const message = [
      `From: ${config.from}`, `To: ${to}`, `Subject: ${oneLine(subject)}`, `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '',
      // dot-stuffing: a line that starts with "." must not end the message early
      String(body).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..'),
    ].join('\r\n');

    const socket = (secure ? tls.connect : net.connect)({ host, port });
    let buffer = '';
    let waiting = null;
    const fail = (e) => { waiting?.reject(e); waiting = null; };
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('mail: connection closed')));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      // a reply is complete at a line like "250 text" (a dash after the code means more lines follow)
      const lines = buffer.split('\r\n');
      const last = lines.at(-2);
      if (waiting && last && /^\d{3} /.test(last)) { const w = waiting; waiting = null; buffer = ''; w.resolve(last); }
    });
    const reply = () => new Promise((resolve, reject) => { waiting = { resolve, reject }; });
    const expect = async (code) => { const r = await reply(); if (!r.startsWith(code)) throw new Error(`mail: server said ${r}`); };
    const command = async (line, code) => { socket.write(`${line}\r\n`); await expect(code); };

    const timer = setTimeout(() => socket.destroy(new Error('mail: timed out')), 10_000);
    try {
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('secureConnect', resolve); socket.once('error', reject); });
      await expect('220');
      await command('EHLO assistant.local', '250');
      if (user && password) {
        await command('AUTH LOGIN', '334');
        await command(Buffer.from(user).toString('base64'), '334');
        await command(Buffer.from(password).toString('base64'), '235');
      }
      await command(`MAIL FROM:<${config.from}>`, '250');
      await command(`RCPT TO:<${to}>`, '250');
      await command('DATA', '354');
      await command(`${message}\r\n.`, '250');
      await command('QUIT', '221');
    } finally {
      clearTimeout(timer);
      socket.destroy();
    }
  }
  return { send };
}
