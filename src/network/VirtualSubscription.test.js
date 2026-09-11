import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VirtualSubscription } from './VirtualSubscription.js';
import { ConnectionState } from '../state/ConnectionState.js';

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
}

class TestNetwork {
  constructor(fields = {}) {
    this.runtime = new TestRuntime();
    this.config = {
      lobbyId: '1',
      tableId: '7',
    };
    this.events = [];
    this.unregistered = false;
    this.connectedPeers = fields.connectedPeers ?? true;
    this.meshFirst = fields.meshFirst ?? false;
  }

  handler(event) {
    this.events.push(event);
  }

  registerConnectedSubscription() {}

  unregisterConnectedSubscription() {
    this.unregistered = true;
  }

  shouldUseMeshFirst() {
    return this.meshFirst;
  }

  hasConnectedPeers() {
    return this.connectedPeers;
  }

  rememberP2PTimeout() {}
}

class ClosingPeerSession {
  constructor() {
    this.readyState = 'open';
    this.closed = false;
    this.onConnected = null;
    this.onDisconnected = null;
    this.onMessage = null;
  }

  isConnected() {
    return this.readyState === 'open';
  }

  close() {
    this.closed = true;
    this.readyState = 'closed';
    this.onDisconnected?.();
  }
}

test('subscription replacement ignores stale close events from the previous peer session', () => {
  const network = new TestNetwork();
  const subscription = new VirtualSubscription({
    network,
    subscriptionLabel: 'inbound',
    channelLabel: 'outbound',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    timeout: 10_000,
    lobbyId: '1',
    tableId: '7',
  });
  const peerSession = new ClosingPeerSession();

  subscription.attachPeerSession(peerSession);
  peerSession.onConnected();

  assert.equal(subscription.state, ConnectionState.PEER_CONNECTED);

  subscription.replaceForOffer('mesh');

  assert.equal(peerSession.closed, true);
  assert.equal(subscription.peerSession, null);
  assert.equal(subscription.state, ConnectionState.TRY_MESH_NODE);
  assert.equal(network.unregistered, true);
  assert.equal(
    network.events.some((event) => event.type === 'PeerDisconnected'),
    false,
  );
});

test('known p2p route takes priority over mesh fallback memory', () => {
  const network = new TestNetwork({
    connectedPeers: true,
    meshFirst: true,
  });
  const subscription = new VirtualSubscription({
    network,
    subscriptionLabel: 'inbound',
    channelLabel: 'outbound',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    timeout: 10_000,
    lobbyId: '1',
    tableId: '7',
  });
  subscription.timedOutOnce = true;

  assert.equal(subscription.shouldTryMeshNodeFirst(), false);
});

test('mesh fallback memory applies only when no p2p route is known', () => {
  const network = new TestNetwork({
    connectedPeers: false,
    meshFirst: false,
  });
  const subscription = new VirtualSubscription({
    network,
    subscriptionLabel: 'inbound',
    channelLabel: 'outbound',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    timeout: 10_000,
    lobbyId: '1',
    tableId: '7',
  });

  assert.equal(subscription.shouldTryMeshNodeFirst(), true);
});

test('missing p2p route starts through mesh on the first attempt', () => {
  const network = new TestNetwork({
    connectedPeers: false,
    meshFirst: false,
  });
  const subscription = new VirtualSubscription({
    network,
    subscriptionLabel: 'inbound',
    channelLabel: 'outbound',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    timeout: 10_000,
    lobbyId: '1',
    tableId: '7',
  });

  assert.equal(subscription.shouldTryMeshNodeFirst(), true);
});

test('same active subscription cannot be restarted by subscribe or poke', () => {
  const network = new TestNetwork();
  const subscription = new VirtualSubscription({
    network,
    subscriptionLabel: 'inbound',
    channelLabel: 'outbound',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    timeout: 10_000,
    lobbyId: '1',
    tableId: '7',
  });
  const peerSession = new ClosingPeerSession();

  subscription.attachPeerSession(peerSession);
  peerSession.onConnected();
  subscription.restart();

  assert.equal(peerSession.closed, false);
  assert.equal(subscription.peerSession, peerSession);
  assert.equal(subscription.state, ConnectionState.PEER_CONNECTED);
});

test('disconnected subscription clears peer session and can restart without unsubscribe', () => {
  const network = new TestNetwork();
  let p2pFinds = 0;
  network.p2pNetwork = {
    findPeer: async () => {
      p2pFinds += 1;
    },
  };
  network.meshNetwork = {
    findPeer: async () => {},
  };
  network.emitConnectionStep = () => {};
  const subscription = new VirtualSubscription({
    network,
    subscriptionLabel: 'inbound',
    channelLabel: 'outbound',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    timeout: 10_000,
    lobbyId: '1',
    tableId: '7',
  });
  const peerSession = new ClosingPeerSession();

  subscription.attachPeerSession(peerSession);
  peerSession.onConnected();
  peerSession.onDisconnected();
  subscription.restart();

  assert.equal(subscription.peerSession, null);
  assert.equal(subscription.state, ConnectionState.TRY_P2P_NETWORK);
  assert.equal(p2pFinds, 1);
});
