import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createMailer } from '../src/mailer.js';

// A local stand-in for a dev mail catcher (Mailpit/MailHog): speaks just enough SMTP and keeps what it receives.
function fakeCatcher() {
  const received = [];
  const server = net.createServer((socket) => {
    let data = false;
    let buffer = '';
    const current = { from: null, to: [], text: '' };
    socket.on('error', () => {});
    socket.write('220 catcher ready\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        if (data) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          current.text = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          data = false;
          received.push({ ...current, to: [...current.to] });
          socket.write('250 queued\r\n');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        if (/^EHLO|^HELO/i.test(line)) socket.write('250 hello\r\n');
        else if (/^MAIL FROM:/i.test(line)) { current.from = /<(.*)>/.exec(line)[1]; current.to = []; socket.write('250 ok\r\n'); }
        else if (/^RCPT TO:/i.test(line)) { current.to.push(/<(.*)>/.exec(line)[1]); socket.write('250 ok\r\n'); }
        else if (/^DATA/i.test(line)) { data = true; socket.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ received, port: server.address().port, close: () => server.close() })));
}

test('log mode (the default) sends nothing: it logs who and the subject, never the body', async () => {
  const lines = [];
  const mailer = createMailer({ mode: 'log', from: 'a@b.test' }, { log: (l) => lines.push(l) });

  await mailer.send({ to: 'x@y.test', subject: '[C-1001] Hello', body: 'secret body text' });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /x@y\.test/);
  assert.match(lines[0], /\[C-1001\] Hello/);
  assert.doesNotMatch(lines[0], /secret body text/);
});

test('smtp mode hands the message to the configured local catcher', async (t) => {
  const catcher = await fakeCatcher();
  t.after(catcher.close);
  const mailer = createMailer({ mode: 'smtp', from: 'assistant@bank.test', smtp: { host: '127.0.0.1', port: catcher.port, secure: false, user: null, password: null } });

  await mailer.send({ to: 'agent@bank.test', subject: '[C-1001] New chat case', body: 'Case: C-1001\n.dot line\nOpen: http://x' });

  assert.equal(catcher.received.length, 1);
  const [m] = catcher.received;
  assert.equal(m.from, 'assistant@bank.test');
  assert.deepEqual(m.to, ['agent@bank.test']);
  assert.match(m.text, /Subject: \[C-1001\] New chat case/);
  assert.match(m.text, /Case: C-1001/);
});

test('a recipient or subject cannot inject headers or extra commands', async (t) => {
  const catcher = await fakeCatcher();
  t.after(catcher.close);
  const mailer = createMailer({ mode: 'smtp', from: 'assistant@bank.test', smtp: { host: '127.0.0.1', port: catcher.port, secure: false } });

  await assert.rejects(mailer.send({ to: 'a@b.test>\r\nRCPT TO:<evil@x.test', subject: 's', body: 'b' }), /recipient/i);
  await mailer.send({ to: 'a@b.test', subject: 'hi\r\nBcc: evil@x.test', body: 'b' });

  assert.equal(catcher.received.length, 1);
  assert.doesNotMatch(catcher.received[0].text, /^Bcc:/m);
});

test('smtp mode fails with an error when the catcher is not there, so the caller can audit it', async () => {
  const mailer = createMailer({ mode: 'smtp', from: 'a@b.test', smtp: { host: '127.0.0.1', port: 1, secure: false } });
  await assert.rejects(mailer.send({ to: 'a@b.test', subject: 's', body: 'b' }));
});
