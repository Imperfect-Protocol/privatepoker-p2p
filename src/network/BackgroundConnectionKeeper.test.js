import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BackgroundConnectionKeeper } from './BackgroundConnectionKeeper.js';
import { TabMessageType } from '../tabs/TabMessage.js';

function makeNetwork() {
  const broadcasts = [];
  const subscriptions = [];
  const created = [];
  const subscription = {
    peerSession: { isConnected: () => false },
  };
  return {
    address: { toString: () => '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    config: { role: 'lobby', lobbyId: '1' },
    broadcasts,
    subscriptions,
    findSubscriptionByPeer: () => (created.length > 0 ? created[0] : null),
    subscribe: (...fields) => {
      subscriptions.push(fields);
      created.push(subscription);
      return subscription;
    },
    broadcastControl: (message) => broadcasts.push(message),
  };
}

function request(fields = {}) {
  return {
    requestId: 'request-1',
    requesterInstanceId: 'table-instance',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    subscriptionLabel: 'inbound',
    channelLabel: 'outbound',
    lobbyId: '1',
    tableId: '7',
    ...fields,
  };
}

test('a table request creates exactly one lobby-owned background subscription', () => {
  const network = makeNetwork();
  const keeper = new BackgroundConnectionKeeper(network);

  keeper.rememberRequest(request());
  keeper.rememberRequest(request());

  assert.equal(network.subscriptions.length, 1);
  assert.deepEqual(network.subscriptions[0].slice(3), [20_000, '1', '0']);
  assert.equal(keeper.requests.get('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb').length, 1);
});

test('a request with an empty peer address is logged as an error and ignored', () => {
  const network = makeNetwork();
  const keeper = new BackgroundConnectionKeeper(network);

  keeper.rememberRequest(request({ peerAddress: '', requestId: 'request-empty' }));

  assert.equal(keeper.requests.size, 0);
  assert.equal(network.subscriptions.length, 0);
  assert.equal(network.broadcasts.length, 0);
});

test('one background edge is shared across different lobby ids for the same peer', () => {
  const network = makeNetwork();
  const keeper = new BackgroundConnectionKeeper(network);

  keeper.rememberRequest(request({ lobbyId: '1', requestId: 'request-a' }));
  keeper.rememberRequest(request({ lobbyId: '2', requestId: 'request-b', peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }));

  assert.equal(network.subscriptions.length, 1);
  assert.equal(keeper.requests.get('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb').length, 2);
});

test('a connected background edge answers pending table requests', () => {
  const network = makeNetwork();
  const keeper = new BackgroundConnectionKeeper(network);
  keeper.rememberRequest(request());

  keeper.answerConnected('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

  assert.equal(keeper.requests.size, 0);
  assert.equal(network.broadcasts.length, 1);
  assert.equal(network.broadcasts[0].type, TabMessageType.FIND_PEER_RESPONSE);
  assert.equal(network.broadcasts[0].status, 'route-ready');
  assert.equal(network.broadcasts[0].targetInstanceId, 'table-instance');
});

test('a failed background edge answers pending table requests with failure', () => {
  const network = makeNetwork();
  const keeper = new BackgroundConnectionKeeper(network);
  keeper.rememberRequest(request({ requestId: 'request-2' }));

  keeper.answerFailed('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

  assert.equal(network.broadcasts[0].status, 'route-failed');
  assert.equal(network.broadcasts[0].requestId, 'request-2');
});
