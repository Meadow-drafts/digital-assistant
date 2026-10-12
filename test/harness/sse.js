// Test client for the service: posts a chat turn and returns parsed events.
export async function chatTurn(baseUrl, body, { token = 'test-token', headers = {} } = {}) {
  const res = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const events = text.split('\n\n').filter(Boolean).map((block) => {
    const type = /^event: (.*)$/m.exec(block)?.[1];
    const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? 'null');
    return { type, ...data };
  });
  return { status: res.status, events };
}
