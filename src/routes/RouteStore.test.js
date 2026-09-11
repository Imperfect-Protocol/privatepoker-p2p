import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RouteStore } from './RouteStore.js';

class TestStorage {
  constructor() {
    this.value = '{}';
  }

  getItem() {
    return this.value;
  }

  setItem(_key, value) {
    this.value = value;
  }
}

test('remembered route intent is not treated as a live p2p route', () => {
  const store = new RouteStore({ storage: new TestStorage() });

  store.remember({
    ownerAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    lobbyId: '1',
    tableId: '7',
    backgroundTableId: '0',
  });

  assert.equal(store.hasPeerRoute({
    ownerAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    lobbyId: '1',
    backgroundTableId: '0',
  }), true);
  assert.equal(store.hasLivePeerRoute({
    ownerAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    lobbyId: '1',
    backgroundTableId: '0',
  }), false);
});

test('live route becomes non-live during recovery without being deleted', () => {
  const store = new RouteStore({ storage: new TestStorage() });
  const fields = {
    ownerAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    lobbyId: '1',
    tableId: '7',
    backgroundTableId: '0',
  };

  store.markLive(fields);
  assert.equal(store.hasLivePeerRoute(fields), true);

  store.markRecovering(fields);

  assert.equal(store.hasPeerRoute(fields), true);
  assert.equal(store.hasLivePeerRoute(fields), false);
});

test('stale live route is not treated as live p2p network', () => {
  const store = new RouteStore({
    storage: new TestStorage(),
    liveRouteTtlMs: 10,
  });
  const fields = {
    ownerAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    lobbyId: '1',
    tableId: '7',
    backgroundTableId: '0',
    live: true,
    liveAt: Date.now() - 100,
  };

  store.remember(fields);

  assert.equal(store.hasPeerRoute(fields), true);
  assert.equal(store.hasLivePeerRoute(fields), false);
});

test('owner recovery clears stale live routes without deleting audit records', () => {
  const store = new RouteStore({ storage: new TestStorage() });
  const route = {
    ownerAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    lobbyId: '1',
    tableId: '7',
    backgroundTableId: '0',
  };

  store.markLive(route);
  store.markOwnerRecovering({
    ownerAddress: route.ownerAddress,
    lobbyId: route.lobbyId,
    backgroundTableId: route.backgroundTableId,
  });

  assert.equal(store.hasPeerRoute(route), true);
  assert.equal(store.hasLivePeerRoute(route), false);
});
