import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LobbyRouteKeeper } from './LobbyRouteKeeper.js';

class TestBus {
  constructor() {
    this.listener = null;
  }

  listen(listener) {
    this.listener = listener;
  }

  publishKeepRoute() {}

  close() {}
}

class TestStore {
  constructor() {
    this.remembered = [];
    this.forgotten = [];
  }

  hasPeerRoute() {
    return false;
  }

  remember(record) {
    this.remembered.push(record);
  }

  forget(record) {
    this.forgotten.push(record);
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
    timer.active = false;
    timer.callback();
  }
}

test('lobby route keeper preserves route intent and reconnects instead of forgetting', () => {
  const bus = new TestBus();
  const store = new TestStore();
  const events = [];
  const keeper = new LobbyRouteKeeper(
    (event) => events.push(event),
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    new Uint8Array(32),
    {
      bus,
      store,
      meshUrls: [],
      reconnectDelayMs: 25,
    },
  );

  keeper.start();
  const runtime = new TestRuntime();
  let subscribeCount = 0;
  keeper.host.runtime = runtime;
  keeper.host.subscribe = () => {
    subscribeCount += 1;
  };
  keeper.host.unsubscribe = () => {};
  keeper.host.controlBus.registerPresence = () => {};
  keeper.host.controlBus.unregisterPresence = () => {};

  keeper.acceptRouteMessage({
    type: 'keep-route',
    ownerAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    lobbyId: '1',
    tableId: '7',
  });
  keeper.handleNetworkEvent({
    type: 'PeerConnected',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  keeper.handleNetworkEvent({
    type: 'ConnectionTimeout',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  runtime.fireTimer();

  assert.equal(subscribeCount, 2);
  assert.equal(store.remembered.length, 1);
  assert.equal(store.forgotten.length, 0);
  assert.ok(events.some((event) => event.step === 'PreserveRouteAccepted'));
  keeper.stop();
});
