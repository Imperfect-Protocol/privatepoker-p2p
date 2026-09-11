import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConnectionState } from './ConnectionState.js';
import { ConnectionAttemptStateMachine } from './ConnectionAttemptStateMachine.js';

class TestSubscription {
  constructor(meshFirst) {
    this.meshFirst = meshFirst;
    this.state = ConnectionState.INITIAL;
    this.timeoutEvents = 0;
    this.failureEvents = 0;
    this.timeout = {
      toMilliseconds: () => 10_000,
    };
  }

  shouldTryMeshNodeFirst() {
    return this.meshFirst;
  }

  rememberTimeout() {
    this.timeoutRemembered = true;
  }

  emitTimeout() {
    this.timeoutEvents += 1;
  }

  emitFailure() {
    this.failureEvents += 1;
  }

  abortNegotiation() {
    this.negotiationAborted = true;
  }
}

class TestRuntime {
  constructor() {
    this.timers = [];
  }

  setTimer(callback, milliseconds) {
    const timer = { callback, milliseconds, active: true };
    this.timers.push(timer);
    return timer;
  }

  clearTimer(timer) {
    timer.active = false;
  }

  fireTimer() {
    const timer = this.timers.find((candidate) => candidate.active);
    assert.ok(timer);
    assert.equal(timer.milliseconds, 10_000);
    timer.active = false;
    timer.callback();
  }
}

test('connection attempt starts in p2p network when connected peers exist', () => {
  const subscription = new TestSubscription(false);
  const runtime = new TestRuntime();
  const stateMachine = new ConnectionAttemptStateMachine(subscription, runtime);

  stateMachine.start();

  assert.equal(subscription.state, ConnectionState.TRY_P2P_NETWORK);
});

test('connection attempt starts in mesh node when no p2p peers exist or p2p already timed out', () => {
  const subscription = new TestSubscription(true);
  const runtime = new TestRuntime();
  const stateMachine = new ConnectionAttemptStateMachine(subscription, runtime);

  stateMachine.start();

  assert.equal(subscription.state, ConnectionState.TRY_MESH_NODE);
});

test('connection attempt moves to timeout state through the single timeout path', () => {
  const subscription = new TestSubscription(false);
  const runtime = new TestRuntime();
  const stateMachine = new ConnectionAttemptStateMachine(subscription, runtime);

  stateMachine.start();
  runtime.fireTimer();

  assert.equal(subscription.state, ConnectionState.CONNECTION_TIMEOUT);
  assert.equal(subscription.timeoutRemembered, true);
  assert.equal(subscription.timeoutEvents, 1);
});

test('connection attempt can wait for peer human without timing out', () => {
  const subscription = new TestSubscription(false);
  const runtime = new TestRuntime();
  const stateMachine = new ConnectionAttemptStateMachine(subscription, runtime);

  stateMachine.start();
  stateMachine.peerWaiting();

  assert.equal(subscription.state, ConnectionState.PEER_WAITING);
  assert.equal(runtime.timers.some((timer) => timer.active), false);
  assert.equal(subscription.timeoutEvents, 0);
});

test('connection attempt can be rejected by peer human without timing out', () => {
  const subscription = new TestSubscription(false);
  const runtime = new TestRuntime();
  const stateMachine = new ConnectionAttemptStateMachine(subscription, runtime);

  stateMachine.start();
  stateMachine.peerRejected();

  assert.equal(subscription.state, ConnectionState.PEER_REJECTED);
  assert.equal(runtime.timers.some((timer) => timer.active), false);
  assert.equal(subscription.negotiationAborted, true);
  assert.equal(subscription.timeoutEvents, 0);
});

test('connection attempt has named connected and failed final states', () => {
  const subscription = new TestSubscription(false);
  const runtime = new TestRuntime();
  const stateMachine = new ConnectionAttemptStateMachine(subscription, runtime);

  stateMachine.start();
  stateMachine.connected();
  assert.equal(subscription.state, ConnectionState.PEER_CONNECTED);

  stateMachine.failed(new Error('boom'));
  assert.equal(subscription.state, ConnectionState.FAILED);
  assert.equal(subscription.failureEvents, 1);
});
