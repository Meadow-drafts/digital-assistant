import http from 'node:http';

// Local stand-in for an OpenAI-compatible provider (Groq, Ollama, ...). Serves
// POST /v1/chat/completions. `script` is an array of behaviours consumed in
// order (the last repeats): a string[] of streamed chunks, or { status, message } for an
// error response (message is the provider's explanation). A string[] may end with { usage } to stream a usage chunk. Records every request (auth header and body) in `requests`.
export async function startFakeProvider(script = [['ok']]) {
  const requests = [];
  let i = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      const step = script[Math.min(i++, script.length - 1)];
      if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
      if (!Array.isArray(step)) { res.writeHead(step.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: step.message ?? 'provider error' } })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const text of step) res.write(`data: ${JSON.stringify(typeof text === 'string' ? { choices: [{ delta: { content: text } }] } : { choices: [], usage: text.usage })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  return { baseUrl, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
