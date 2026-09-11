import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VirtualNetworkLogFormatter } from './VirtualNetworkLogFormatter.js';

test('log formatter labels lobby-channel SDP rows', () => {
  const line = VirtualNetworkLogFormatter.text('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
    type: 'MessageDelivered',
    tableId: '0',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    messageData: {
      type: 'sdp-offer',
      tableId: '0',
    },
  });

  assert.equal(line, '[BB] >> Offer -> Lobby');
});

test('log formatter leaves ordinary table SDP rows unmarked', () => {
  const line = VirtualNetworkLogFormatter.text('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
    type: 'MessageDelivered',
    tableId: '7',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    messageData: {
      type: 'sdp-offer',
      tableId: '7',
    },
  });

  assert.equal(line, '[BB] >> Offer');
});

test('log formatter labels lobby connections', () => {
  const line = VirtualNetworkLogFormatter.text('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
    type: 'PeerConnected',
    tableId: '0',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });

  assert.equal(line, '[BB] == Connected -> Lobby');
});

test('log formatter shows RTC work before offer and answer are sent', () => {
  const offerLine = VirtualNetworkLogFormatter.text('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
    type: 'ConnectionStep',
    step: 'OfferCreating',
    tableId: '7',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const answerLine = VirtualNetworkLogFormatter.text('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
    type: 'ConnectionStep',
    step: 'AnswerCreating',
    tableId: '7',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });

  assert.equal(offerLine, '[BB] .. Creating Offer');
  assert.equal(answerLine, '[BB] .. Creating Answer');
});

test('log formatter shows connection replacement explicitly', () => {
  const line = VirtualNetworkLogFormatter.text('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
    type: 'ConnectionStep',
    step: 'ReplacingConnection',
    tableId: '7',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });

  assert.equal(line, '[BB] .. Replacing Connection');
});

test('log formatter shows peer waiting explicitly', () => {
  const line = VirtualNetworkLogFormatter.text('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
    type: 'PeerWaiting',
    tableId: '7',
    peerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });

  assert.equal(line, '[BB] .. Peer Waiting');
});
