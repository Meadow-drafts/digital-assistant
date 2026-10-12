import { createFakeModel } from './fake-model.js';

// Fake model for how-to tests: the router call (request.purpose === 'route')
// answers with `picks` as a JSON array of guide ids, every other call with
// `answer`. Requests are recorded in `calls` like any fake model.
export function createGuideModel({ picks = [], answer = ['Here are the steps.'] } = {}) {
  return createFakeModel((request) => (request.purpose === 'route' ? JSON.stringify(picks) : answer));
}
