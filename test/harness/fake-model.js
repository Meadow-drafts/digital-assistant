// Scripted fake model adapter. `script` is an array of replies (string or
// string[] of chunks) consumed in order, or a function (request) => reply.
// `gate` is an optional promise the model awaits before replying. Records every request it receives in `calls`.
export function createFakeModel(script = ['ok'], { gate } = {}) {
  const calls = [];
  let i = 0;
  return {
    name: 'fake-model',
    calls,
    async *chat(request) {
      calls.push(request);
      if (gate) await gate; // lets a test hold a reply open to observe the thinking state
      const reply = typeof script === 'function' ? script(request) : script[Math.min(i++, script.length - 1)];
      if (reply instanceof Error) throw reply;
      for (const chunk of Array.isArray(reply) ? reply : [reply]) yield chunk;
    },
  };
}
