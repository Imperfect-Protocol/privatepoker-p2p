import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VirtualNetwork } from './VirtualNetwork.js';
import { VirtualNetworkHost } from './VirtualNetworkHost.js';
import { ControlMessage } from './ControlMessage.js';
import { ConnectionState } from '../state/ConnectionState.js';
import { ConnectionStep } from '../events/ConnectionStep.js';

test('control messages keep a neural bundle payload', () => {
  const message = ControlMessage.create(
    { type: 'neural-bundle', neural: { signals: [{ sequenceId: 1 }] } },
    { crypto: globalThis.crypto },
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    1,
    'instance',
  );

  assert.deepEqual(message.toFields().neural, { signals: [{ sequenceId: 1 }] });
});

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

  assert.deepEqual(methodNames, ['subscribe', 'unsubscribe', 'send', 'setLocalStream', 'close']);
});

test('remote subscriptions created from incoming signals are registered with the control bus', () => {
  const runtime = {
    BroadcastChannel: null,
    RTCPeerConnection: null,
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

  sendControl() {}

  applyAnswer() {}

  close() {
    this.closed = true;
    this.onDisconnected?.();
  }
}

function makeHost(fields = {}) {
  const runtime = {
    BroadcastChannel: null,
    RTCPeerConnection: null,
    clearTimer: clearTimeout,
    crypto: globalThis.crypto,
    setTimer: setTimeout,
  };
  const host = new VirtualNetworkHost(
    fields.handler ?? (() => {}),
    fields.address ?? '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    new Uint8Array(32),
    {
      role: fields.role ?? 'peer',
      routeOracle: fields.routeOracle ?? (() => true),
    },
    runtime,
  );
  host.controlBus.register = () => {};
  host.controlBus.unregister = () => {};
  host.p2pNetwork.findPeer = async () => {};
  host.meshNetwork.findPeer = async () => {};
  return host;
}

function connectPeer(host, peerAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') {
  host.subscribe('inbound', 'outbound', peerAddress, 10_000, '1', '7');
  const subscription = Array.from(host.subscriptions.values()).at(-1);
  const peerSession = new TestPeerSession();
  subscription.attachPeerSession(peerSession);
  peerSession.onConnected();
  return subscription;
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

test('a sibling tab relays control traffic that this host owns a route for', () => {
  const host = makeHost({ role: 'lobby' });
  connectPeer(host);
  const relayed = [];
  host.p2pNetwork.sendTo = (target, fields) => relayed.push({ target, type: fields.type });

  host.relayLocalControl({
    id: 'announce-1',
    type: 'p2p-mst-announce',
    from: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    senderRole: 'table',
    senderInstanceId: 'table-instance',
    ttl: 8,
  });

  assert.deepEqual(relayed, [{
    target: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    type: 'p2p-mst-announce',
  }]);
  host.close();
});

test('relaying skips messages for this address and messages from this role', () => {
  const host = makeHost({ role: 'lobby' });
  connectPeer(host);
  const relayed = [];
  host.p2pNetwork.sendTo = (target) => relayed.push(target);

  host.relayLocalControl({
    id: 'self-1',
    type: 'p2p-mst-announce',
    from: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    senderRole: 'table',
    ttl: 8,
  });
  host.relayLocalControl({
    id: 'lobby-1',
    type: 'p2p-mst-announce',
    from: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    senderRole: 'lobby',
    ttl: 8,
  });

  assert.deepEqual(relayed, []);
  host.close();
});

test('a host without neighbours never relays', () => {
  const host = makeHost({ role: 'table' });
  const relayed = [];
  host.p2pNetwork.sendTo = (target) => relayed.push(target);

  host.relayLocalControl({
    id: 'announce-2',
    type: 'p2p-mst-announce',
    from: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    senderRole: 'lobby',
    ttl: 8,
  });

  assert.deepEqual(relayed, []);
  host.close();
});

test('a known app route defers the mesh fallback', () => {
  const host = makeHost({ role: 'table' });
  const subscription = connectPeer(host);
  subscription.handleDisconnected(subscription.peerSession);
  let meshLookups = 0;
  host.meshNetwork.findPeer = async () => {
    meshLookups += 1;
  };

  host.requestMeshFallback(subscription.peerAddress.toString());

  assert.equal(meshLookups, 0);
  host.close();
});

test('a p2p offer replaces an in-progress mesh negotiation', async () => {
  const host = makeHost({ role: 'peer', routeOracle: () => false });
  host.subscribe(
    'inbound',
    'outbound',
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    10_000,
    '1',
    '7',
  );
  const subscription = Array.from(host.subscriptions.values()).at(-1);
  assert.equal(subscription.state, ConnectionState.TRY_MESH_NODE);
  subscription.attachPeerSession(new TestPeerSession());

  const sent = [];
  host.createPeerSession = () => {
    const peerSession = new TestPeerSession();
    peerSession.createOffer = async () => ({ sdp: 'offer' });
    return peerSession;
  };
  host.broadcastControl = (message) => sent.push(message);

  await host.handleP2PAnnounce({
    to: host.address.toString(),
    from: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    subscriptionLabel: 'inbound',
    channelLabel: 'outbound',
    lobbyId: '1',
    tableId: '7',
  });

  assert.equal(sent[0].type, 'sdp-offer');
  assert.equal(sent[0].via, 'p2p');
  assert.equal(subscription.state, ConnectionState.TRY_P2P_NETWORK);
  host.close();
});

test('a live p2p connection ignores a stale mesh offer', async () => {
  const events = [];
  const host = makeHost({ handler: (event) => events.push(event) });
  const subscription = connectPeer(host);
  const liveSession = subscription.peerSession;
  let createdSessions = 0;
  host.createPeerSession = () => {
    createdSessions += 1;
    return new TestPeerSession();
  };

  await host.handleMeshOffer({
    from: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    to: host.address.toString(),
    subscriptionLabel: 'inbound',
    channelLabel: 'outbound',
    lobbyId: '1',
    tableId: '7',
    flowId: 'stale-mesh-flow',
    sdp: 'stale offer',
  }, () => {});

  assert.equal(createdSessions, 0);
  assert.equal(subscription.peerSession, liveSession);
  assert.equal(subscription.state, ConnectionState.PEER_CONNECTED);
  assert.equal(events.some((event) => event.step === ConnectionStep.REPLACING_CONNECTION), false);
  host.close();
});

test('a stale mesh answer leaves a live peer session untouched', async () => {
  const host = makeHost();
  const subscription = connectPeer(host);
  const liveSession = subscription.peerSession;
  let appliedAnswers = 0;
  liveSession.applyAnswer = () => {
    appliedAnswers += 1;
  };

  await host.handleMeshAnswer({
    from: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    to: host.address.toString(),
    lobbyId: '1',
    tableId: '7',
    flowId: 'stale-mesh-flow',
    sdp: 'stale answer',
  });

  assert.equal(appliedAnswers, 0);
  assert.equal(subscription.peerSession, liveSession);
  assert.equal(subscription.state, ConnectionState.PEER_CONNECTED);
  host.close();
});

test('without an app route the mesh fallback still runs', () => {
  const host = makeHost({ role: 'table', routeOracle: () => false });
  const subscription = host.subscribe(
    'inbound',
    'outbound',
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    10_000,
    '1',
    '7').ok;
  assert.equal(subscription, true);
  const created = Array.from(host.subscriptions.values()).at(-1);
  let meshLookups = 0;
  host.meshNetwork.findPeer = async () => {
    meshLookups += 1;
  };

  host.requestMeshFallback(created.peerAddress.toString());

  assert.equal(meshLookups, 1);
  host.close();
});


const PEER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PEER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const announceFrom = (peerAddress) => ({
  type: 'p2p-mst-announce',
  from: peerAddress,
  lobbyId: '1',
  tableId: '7',
});

const offerFrom = (peerAddress) => ({
  type: 'sdp-offer',
  from: peerAddress,
  via: 'p2p',
  lobbyId: '1',
  tableId: '7',
});

const answerFrom = (peerAddress) => ({
  type: 'sdp-answer',
  from: peerAddress,
  to: PEER_A,
  subscriptionLabel: 'inbound',
  channelLabel: 'outbound',
  lobbyId: '1',
  tableId: '7',
  sdp: 'answer',
});

test('simultaneous p2p announces: lower address offers while the higher address stays quiet', () => {
  const lower = makeHost({ address: PEER_A });
  lower.subscribe('inbound', 'outbound', PEER_B, 10_000, '1', '7');
  const lowerSubscription = Array.from(lower.subscriptions.values()).at(-1);
  lowerSubscription.state = ConnectionState.INITIAL;
  assert.equal(lower.shouldCreateP2POffer(announceFrom(PEER_B)), true);

  const higher = makeHost({ address: PEER_B });
  higher.subscribe('inbound', 'outbound', PEER_A, 10_000, '1', '7');
  const higherSubscription = Array.from(higher.subscriptions.values()).at(-1);
  higherSubscription.state = ConnectionState.INITIAL;
  assert.equal(higher.shouldCreateP2POffer(announceFrom(PEER_A)), false);

  lower.close();
  higher.close();
});

test('simultaneous p2p offers: the lower address keeps its own offer', () => {
  const host = makeHost({ address: PEER_A });
  host.subscribe('inbound', 'outbound', PEER_B, 10_000, '1', '7');
  const subscription = Array.from(host.subscriptions.values()).at(-1);
  subscription.state = ConnectionState.TRY_P2P_NETWORK;
  const localOffer = {
    closed: false,
    isConnected: () => false,
    hasLocalOffer: () => true,
    close() {
      this.closed = true;
    },
  };
  subscription.attachPeerSession(localOffer);
  subscription.localOfferSent = true;

  const accepted = host.prepareIncomingOffer(subscription, offerFrom(PEER_B));

  assert.equal(accepted, false);
  assert.equal(localOffer.closed, false);
  host.close();
});

test('simultaneous p2p offers: the higher address replaces its own offer', () => {
  const host = makeHost({ address: PEER_B });
  host.subscribe('inbound', 'outbound', PEER_A, 10_000, '1', '7');
  const subscription = Array.from(host.subscriptions.values()).at(-1);
  subscription.state = ConnectionState.TRY_P2P_NETWORK;
  const localOffer = {
    closed: false,
    isConnected: () => false,
    hasLocalOffer: () => true,
    close() {
      this.closed = true;
    },
  };
  subscription.attachPeerSession(localOffer);
  subscription.localOfferSent = true;

  const accepted = host.prepareIncomingOffer(subscription, offerFrom(PEER_A));

  assert.equal(accepted, true);
  assert.equal(localOffer.closed, true);
  host.close();
});

test('a p2p answer is ignored unless a local offer is outstanding', async () => {
  const host = makeHost({ address: PEER_A });
  host.subscribe('inbound', 'outbound', PEER_B, 10_000, '1', '7');
  const subscription = Array.from(host.subscriptions.values()).at(-1);
  let applied = 0;
  subscription.attachPeerSession({
    isConnected: () => false,
    hasLocalOffer: () => false,
    applyAnswer: async () => {
      applied += 1;
    },
    close() {},
  });

  await host.handleSdpAnswer(answerFrom(PEER_B));
  assert.equal(applied, 0);

  subscription.peerSession.hasLocalOffer = () => true;
  await host.handleSdpAnswer(answerFrom(PEER_B));
  assert.equal(applied, 1);

  host.close();
});

test('an inbound p2p offer beats a local offer that has not reached the wire', () => {
  const host = makeHost({ address: PEER_A });
  host.subscribe('inbound', 'outbound', PEER_B, 10_000, '1', '7');
  const subscription = Array.from(host.subscriptions.values()).at(-1);
  subscription.state = ConnectionState.TRY_P2P_NETWORK;
  const creatingOffer = {
    closed: false,
    isConnected: () => false,
    hasLocalOffer: () => true,
    close() {
      this.closed = true;
    },
  };
  subscription.attachPeerSession(creatingOffer);
  subscription.localOfferSent = false;

  const accepted = host.prepareIncomingOffer(subscription, offerFrom(PEER_B));

  assert.equal(accepted, true);
  assert.equal(creatingOffer.closed, true);
  assert.equal(subscription.localOfferSent, false);
  host.close();
});

test('a local offer is withheld when the session is replaced while creating it', async () => {
  const host = makeHost({ address: PEER_B });
  host.subscribe('inbound', 'outbound', PEER_A, 10_000, '1', '7');
  const subscription = Array.from(host.subscriptions.values()).at(-1);
  let wireMessages = 0;
  host.broadcastControl = () => {
    wireMessages += 1;
  };
  host.createPeerSession = () => ({
    hasLocalOffer: () => true,
    isConnected: () => false,
    close() {},
    async createOffer() {
      subscription.replaceForOffer('p2p');
      return { type: 'offer', sdp: 'stale-offer' };
    },
  });

  await host.sendOffer(PEER_A, 'inbound', 'outbound', 'p2p', '', '1', '7');

  assert.equal(wireMessages, 0);
  assert.equal(subscription.localOfferSent, false);
  host.close();
});
