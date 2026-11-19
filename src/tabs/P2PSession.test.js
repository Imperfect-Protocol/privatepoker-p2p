import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LobbyP2PSession } from './LobbyP2PSession.js';
import { TableP2PSession } from './TableP2PSession.js';

const ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PEER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

test('LobbyP2PSession owns the neural routing node, not the table', () => {
  const session = new LobbyP2PSession({ address: ADDRESS, privateKey: {}, lobbyId: '1' });
  assert.equal(session.host.config.role, 'lobby');
  assert.equal(session.host.config.tableId, '0');
  assert.notEqual(session.host.p2pNetwork.constructor.name, 'LobbyRouteClient');
  session.close();
});

test('TableP2PSession owns no neural node', () => {
  const session = new TableP2PSession({ address: ADDRESS, privateKey: {}, peerId: 'parent-1', lobbyId: '1', tableId: '7' });
  assert.equal(session.host.config.role, 'table');
  assert.equal(session.host.p2pNetwork.constructor.name, 'LobbyRouteClient');
  assert.equal(session.host.meshNetwork.sessions.size, 0);
  session.close();
});

test('TableP2PSession subscription targets the requested peer and scope', () => {
  const session = new TableP2PSession({ address: ADDRESS, privateKey: {}, peerId: 'parent-1', lobbyId: '1', tableId: '7' });
  session.subscribe(PEER);
  const subscription = session.host.findSubscriptionByPeer(PEER, '1', '7');
  assert.ok(subscription);
  assert.equal(subscription.subscriptionLabel, 'inbound');
  assert.equal(subscription.channelLabel, 'outbound');
  session.close();
});

test('TableP2PSession poke restarts the subscription to the requested peer', () => {
  const session = new TableP2PSession({ address: ADDRESS, privateKey: {}, peerId: 'parent-1', lobbyId: '1', tableId: '7' });
  session.subscribe(PEER);
  const subscription = session.host.findSubscriptionByPeer(PEER, '1', '7');
  let restarts = 0;
  subscription.forceRestart = () => {
    restarts += 1;
  };

  const result = session.poke(PEER);

  assert.equal(result.ok, true);
  assert.equal(restarts, 1);
  session.close();
});

test('TableP2PSession reports outbound connectivity from the connected channel', () => {
  const session = new TableP2PSession({ address: ADDRESS, privateKey: {}, peerId: 'parent-1', lobbyId: '1', tableId: '7' });
  assert.equal(session.isOutboundConnected(), false);

  session.host.channels.set('outbound', {
    label: 'outbound',
    subscription: { peerSession: { isConnected: () => true } },
  });
  assert.equal(session.isOutboundConnected(), true);
  session.close();
});