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

function makeHost(fields = {}) {
  const runtime = {
    BroadcastChannel: null,
    RTCPeerConnection: null,
    SharedWorker: null,
    clearTimer: clearTimeout,
    crypto: globalThis.crypto,
    setTimer: setTimeout,
  };
  const host = new VirtualNetworkHost(
    fields.handler ?? (() => {}),
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

test('lobby route answers table p2p announce with peer waiting message', () => {
  const events = [];
  const host = makeHost({ handler: (event) => events.push(event) });
  host.config.role = 'lobby';
  const responses = [];
  host.broadcastControl = (message) => responses.push(message);
  host.respondPeerWaitingWhenLobbyRouteFound({
    type: 'p2p-mst-announce',
    from: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    senderRole: 'table',
    targetRole: 'table',
    initiatorInstanceId: 'table-instance',
    subscriptionLabel: 'inbound',
    channelLabel: 'outbound',
    lobbyId: '1',
    tableId: '7',
  });

  assert.equal(responses.length, 1);
  assert.equal(responses[0].type, 'p2p-peer-waiting');
  assert.equal(responses[0].targetRole, 'table');
  assert.equal(responses[0].targetInstanceId, 'table-instance');
  assert.equal(events.at(-1).type, 'PeerWaitRequest');
  assert.equal(events.at(-1).requesterInstanceId, 'table-instance');
});

test('peer waiting rejection moves requester to rejected state', () => {
  const events = [];
  const host = makeHost({ handler: (event) => events.push(event) });
  host.subscribe(
    'inbound',
    'outbound',
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    10_000,
    '1',
    '7',
  );

  host.handleP2PPeerWaitRejected({
    type: 'p2p-peer-waiting-rejected',
    from: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    targetRole: 'peer',
    subscriptionLabel: 'inbound',
    channelLabel: 'outbound',
    lobbyId: '1',
    tableId: '7',
    decisionReason: 'later',
  });

  assert.equal(events.at(-1).type, 'PeerWaitRejected');
  assert.equal(events.at(-1).state, 'PeerRejected');
});
