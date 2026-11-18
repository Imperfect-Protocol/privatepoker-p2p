import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MeshPollSession } from './MeshPollSession.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

class ControlledFetch {
  constructor() {
    this.requests = [];
  }

  call = (url, options) => new Promise((resolve, reject) => {
    this.requests.push({
      url,
      options,
      messages: JSON.parse(options.body).messages,
      resolve,
      reject,
    });
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });

  async respond(index, messages) {
    this.requests[index].resolve({ ok: true, json: async () => ({ messages }) });
    await tick();
    await tick();
  }
}

function makeSession(fetch) {
  const delivered = [];
  const session = new MeshPollSession({
    network: {
      network: { runtime: { setTimer: setTimeout } },
      handleMeshMessage: async (message) => delivered.push(message),
      handleMeshPollError: (error) => { throw error; },
    },
    lobbyId: '1',
    tableId: '0',
    peer: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    urls: ['http://mesh'],
    fetch: fetch.call,
  });
  return { session, delivered };
}

test('queued messages travel on their own request without cancelling the long poll', async () => {
  const fetch = new ControlledFetch();
  const { session, delivered } = makeSession(fetch);

  session.start();
  await tick();
  assert.equal(fetch.requests.length, 1);

  session.enqueue({ type: 'bootstrap-announce' });
  await tick();
  assert.equal(fetch.requests.length, 2);
  assert.deepEqual(fetch.requests[1].messages, [{ type: 'bootstrap-announce' }]);
  assert.equal(fetch.requests[0].options.signal.aborted, false);

  await fetch.respond(0, [{ type: 'p2p-route-available' }]);
  assert.deepEqual(delivered, [{ type: 'p2p-route-available' }]);
  assert.equal(fetch.requests[0].options.signal.aborted, false);

  session.stop();
});

test('stopping the session aborts the polls still in flight', async () => {
  const fetch = new ControlledFetch();
  const { session } = makeSession(fetch);

  session.start();
  await tick();
  assert.equal(fetch.requests.length, 1);

  session.stop();
  await tick();
  assert.equal(fetch.requests[0].options.signal.aborted, true);
  assert.equal(fetch.requests.length, 1);
});

test('outbound messages queued during a flush are sent next', async () => {
  const fetch = new ControlledFetch();
  const { session } = makeSession(fetch);

  session.start();
  await tick();
  session.enqueue({ type: 'bootstrap-announce' });
  await tick();
  session.enqueue({ type: 'bootstrap-answer' });
  await tick();

  assert.deepEqual(fetch.requests[1].messages, [{ type: 'bootstrap-announce' }]);

  await fetch.respond(1, []);
  assert.deepEqual(fetch.requests[2].messages, [{ type: 'bootstrap-answer' }]);
  session.stop();
});
