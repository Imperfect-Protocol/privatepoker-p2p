import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LobbyRouteClient } from './LobbyRouteClient.js';
import { TabMessageType } from '../tabs/TabMessage.js';
import { SubscriptionScope } from './SubscriptionScope.js';

function makeNetwork({ connected = false } = {}) {
  const broadcasts = [];
  const discoveries = [];
  const steps = [];
  let handler = null;
  const peerSession = { isConnected: () => connected };
  return {
    address: { toString: () => '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    instanceId: 'table-instance',
    config: { role: 'table' },
    broadcasts,
    discoveries,
    steps,
    handler: (event) => handler?.(event),
    bindHandler: (value) => { handler = value; },
    publishDiscovery: (fields) => {
      discoveries.push(fields);
      return { ...fields, id: 'discovery-1' };
    },
    emitConnectionStep: (fields) => steps.push(fields),
    broadcastControl: (message) => broadcasts.push(message),
    peerSession,
    getSubscriptionPeerSession: () => peerSession,
  };
}

function subscription(network) {
  return {
    subscriptionLabel: 'inbound',
    channelLabel: 'outbound',
    peerAddress: { toString: () => '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    lobbyId: '1',
    tableId: '7',
    scope: () => SubscriptionScope.from({
      subscriptionLabel: 'inbound',
      channelLabel: 'outbound',
      peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      lobbyId: '1',
      tableId: '7',
    }),
  };
}

test('a table find-peer request is published with a deterministic request id', () => {
  const network = makeNetwork();
  const client = new LobbyRouteClient(network);

  void client.findPeer(subscription(network));

  assert.equal(network.broadcasts.length, 1);
  const request = network.broadcasts[0];
  assert.equal(request.type, TabMessageType.FIND_PEER_REQUEST);
  assert.equal(request.targetRole, 'lobby');
  assert.equal(request.requesterInstanceId, 'table-instance');
  assert.equal(request.peerAddress, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
});

test('a route-ready response publishes the P2P announce over the lobby edge', () => {
  const network = makeNetwork();
  const client = new LobbyRouteClient(network);
  const sub = subscription(network);
  void client.findPeer(sub);

  const handled = client.handleFindPeerResponse({
    type: TabMessageType.FIND_PEER_RESPONSE,
    status: 'route-ready',
    requestId: network.broadcasts[0].requestId,
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    subscriptionLabel: 'inbound',
    channelLabel: 'outbound',
    lobbyId: '1',
    tableId: '7',
  });

  assert.equal(handled, true);
  assert.equal(network.discoveries.length, 1);
  assert.equal(network.discoveries[0].type, 'p2p-mst-announce');
  assert.equal(network.discoveries[0].targetRole, 'table');
  assert.ok(network.steps.some((step) => step.step === 'RouteAvailable' && step.via === 'lobby'));
  assert.ok(network.steps.some((step) => step.step === 'AnnounceSent' && step.via === 'p2p'));
});

test('a route-failed response surfaces a connection failure event', () => {
  const network = makeNetwork();
  const client = new LobbyRouteClient(network);
  const failures = [];
  network.bindHandler((event) => {
    if (event.type === 'ConnectionFailed') failures.push(event);
  });
  void client.findPeer(subscription(network));

  client.handleFindPeerResponse({
    type: TabMessageType.FIND_PEER_RESPONSE,
    status: 'route-failed',
    requestId: network.broadcasts[0].requestId,
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    subscriptionLabel: 'inbound',
    channelLabel: 'outbound',
    lobbyId: '1',
    tableId: '7',
  });

  assert.equal(failures.length, 1);
  assert.equal(failures[0].peerAddress, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
});
