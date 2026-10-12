// Fake Spring Boot gateway. `routes` maps "METHOD /path" to a response body or
// a function (request) => body | { status, body }. Failure modes are set with
// failWith(status). Records every call (token included, for assertions that it
// was forwarded server-side).
export function createFakeGateway(routes = {}) {
  const calls = [];
  let forcedStatus = null;
  return {
    calls,
    failWith(status) { forcedStatus = status; },
    recover() { forcedStatus = null; },
    async request({ method, path, token, body }) {
      calls.push({ method, path, token, body });
      if (forcedStatus) return { status: forcedStatus, body: null };
      const route = routes[`${method} ${path}`];
      if (route === undefined) return { status: 404, body: null };
      const out = typeof route === 'function' ? route({ method, path, token, body }) : route;
      return out && typeof out.status === 'number' ? out : { status: 200, body: out };
    },
  };
}
