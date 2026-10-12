// Fake Spring Boot gateway. `routes` maps "METHOD /path" to a response body or
// a function (request) => body | { status, body }. Failure modes are set with
// failWith(status). Records every call (token and tenant included, for
// assertions that the token was forwarded server-side and nowhere else).
export function createFakeGateway(routes = {}) {
  const calls = [];
  let forcedStatus = null;
  return {
    calls,
    failWith(status) { forcedStatus = status; },
    recover() { forcedStatus = null; },
    async request({ tenant, method, path, query, token, body }) {
      calls.push({ tenant, method, path, query, token, body });
      if (forcedStatus) return { status: forcedStatus, body: null };
      const route = routes[`${method} ${path}`];
      if (route === undefined) return { status: 404, body: null };
      const out = typeof route === 'function' ? route({ tenant, method, path, query, token, body }) : route;
      return out && typeof out.status === 'number' ? out : { status: 200, body: out };
    },
  };
}
