import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { detectLanguage } from './language.js';

const PUBLIC = new URL('../public/', import.meta.url);
// Only these files are served; no user-controlled path ever reaches the disk.
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/widget.js': ['widget.js', 'text/javascript; charset=utf-8'],
};
const MAX_BODY = 16 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Pseudonymous user id for the audit log. Until the gateway client id is fixed
// per conversation (T1 tickets), it is a one-way digest of the bearer token;
// the token itself is never stored or logged.
function pseudonym(req) {
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? 'anonymous';
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

export function createService({ model, clock, audit }) {
  const conversations = new Map();

  async function handleChat(req, res) {
    let body;
    try { body = await readJson(req); } catch { res.writeHead(400).end(); return; }
    if (typeof body?.message !== 'string' || !body.message.trim()) { res.writeHead(400).end(); return; }

    const conversationId = body.conversationId ?? randomUUID();
    const conversation = conversations.get(conversationId) ?? { history: [], language: 'en' };
    const { history } = conversation;
    conversation.language = detectLanguage(body.message, conversation.language);
    const { language } = conversation;
    history.push({ role: 'user', content: body.message });
    conversations.set(conversationId, conversation);

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    send(res, 'thinking', {});
    const startedAt = clock.now();
    let reply = '';
    let outcome = 'ok';
    try {
      for await (const text of model.chat({ messages: history, language })) {
        reply += text;
        send(res, 'delta', { text });
      }
      history.push({ role: 'assistant', content: reply });
      send(res, 'done', { conversationId, language });
    } catch {
      outcome = 'error';
      send(res, 'error', { code: 'model_unavailable' });
    }
    await audit.append({
      time: new Date(clock.now()).toISOString(),
      user: pseudonym(req),
      tenant: body.tenant ?? null,
      conversationId,
      userText: body.message,
      replyText: reply,
      language,
      model: model.name,
      latencyMs: clock.now() - startedAt,
      outcome,
    });
    res.end();
  }

  return http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/chat') {
      handleChat(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
      return;
    }
    const file = req.method === 'GET' ? STATIC[req.url] : undefined;
    if (file) {
      readFile(new URL(file[0], PUBLIC)).then(
        (data) => res.writeHead(200, { 'content-type': file[1] }).end(data),
        () => res.writeHead(500).end(),
      );
      return;
    }
    res.writeHead(404).end();
  });
}
