import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VirtualNetwork } from './VirtualNetwork.js';
import { VirtualNetworkHost } from './VirtualNetworkHost.js';

test('virtual network public surface stays tiny', () => {
  const runtime = {
    BroadcastChannel: null,
    RTCPeerConnection: null,
    clearTimer: clearTimeout,
    crypto: globalThis.crypto,
    setTimer: setTimeout,
  };
  const network = new VirtualNetwork(() => {}, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', new Uint8Array(32), {}, runtime);
  const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(network)).filter((name) => name !== 'constructor');

  assert.deepEqual(methodNames, ['subscribe', 'unsubscribe', 'send']);
});

test('remote subscriptions created from incoming signals are registered with the control bus', () => {
  const runtime = {
    BroadcastChannel: null,
    RTCPeerConnection: null,
    SharedWorker: null,
    clearTimer: clearTimeout,
    crypto: globalThis.crypto,
    setTimer: setTimeout,
  };
  const host = new VirtualNetworkHost(
    () => {},
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    new Uint8Array(32),
    {},
    runtime,
  );
  const registered = [];
  host.controlBus.register = (subscription) => registered.push(subscription.subscriptionLabel);

  host.findOrCreateRemoteSubscription({
    from: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    subscriptionLabel: 'inbound',
    channelLabel: 'outbound',
    lobbyId: '1',
    tableId: '7',
  });

  assert.deepEqual(registered, ['inbound']);
});

class TestPeerSession {
  constructor() {
    this.closed = false;
    this.onConnected = null;
    this.onDisconnected = null;
    this.onMessage = null;
  }

  isConnected() {
    return !this.closed;
  }

  close() {
    this.closed = true;
    this.onDisconnected?.();
  }
}

function makeHost() {
  const runtime = {
    BroadcastChannel: null,
    RTCPeerConnection: null,
    SharedWorker: null,
    clearTimer: clearTimeout,
    crypto: globalThis.crypto,
    setTimer: setTimeout,
  };
  const host = new VirtualNetworkHost(
    () => {},
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    new Uint8Array(32),
    {
      routeOracle: () => true,
    },
    runtime,
  );
  host.controlBus.register = () => {};
  host.controlBus.unregister = () => {};
  host.p2pNetwork.findPeer = async () => {};
  host.meshNetwork.findPeer = async () => {};
  return host;
}

test('subscribe keeps the same connected scoped subscription', () => {
  const host = makeHost();
  host.subscribe(
    'inbound',
    'outbound',
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    10_000,
    '1',
    '7',
  );
  const subscription = Array.from(host.subscriptions.values())[0];
  const peerSession = new TestPeerSession();
  subscription.attachPeerSession(peerSession);
  peerSession.onConnected();

  host.subscribe(
    'inbound',
    'outbound',
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    10_000,
    '1',
    '7',
  );

  assert.equal(peerSession.closed, false);
  assert.equal(host.subscriptions.size, 1);
});

test('subscribe adds a second scoped connection without killing existing p2p transport', () => {
  const host = makeHost();
  host.subscribe(
    'inbound',
    'outbound',
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    10_000,
    '1',
    '0',
  );
  const subscription = Array.from(host.subscriptions.values())[0];
  const peerSession = new TestPeerSession();
  subscription.attachPeerSession(peerSession);
  peerSession.onConnected();

  host.subscribe(
    'inbound',
    'outbound',
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    10_000,
    '1',
    '7',
  );

  assert.equal(peerSession.closed, false);
  assert.equal(host.subscriptions.size, 2);
});
