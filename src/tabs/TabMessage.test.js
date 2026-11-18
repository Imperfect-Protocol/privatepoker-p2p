import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TabMessage, TabMessageType } from './TabMessage.js';

test('find-peer request is a self-contained value object', () => {
  const message = TabMessage.findPeerRequest({
    requestId: 'request-1',
    requesterInstanceId: 'table-1',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    subscriptionLabel: 'inbound',
    channelLabel: 'outbound',
    lobbyId: '1',
    tableId: '7',
  });

  assert.deepEqual(message, {
    type: TabMessageType.FIND_PEER_REQUEST,
    requestId: 'request-1',
    requesterInstanceId: 'table-1',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    subscriptionLabel: 'inbound',
    channelLabel: 'outbound',
    lobbyId: '1',
    tableId: '7',
  });
});

test('find-peer response carries the request identity and outcome', () => {
  const message = TabMessage.findPeerResponse({
    status: 'route-ready',
    requestId: 'request-1',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    subscriptionLabel: 'inbound',
    channelLabel: 'outbound',
    lobbyId: '1',
    tableId: '7',
  });

  assert.equal(message.type, TabMessageType.FIND_PEER_RESPONSE);
  assert.equal(message.status, 'route-ready');
  assert.equal(message.requestId, 'request-1');
  assert.equal(message.tableId, '7');
});
