// Fake mail sender: collects messages in `outbox` instead of sending.
export function createFakeMailer() {
  const outbox = [];
  return {
    outbox,
    async send(message) { outbox.push({ ...message }); },
  };
}
