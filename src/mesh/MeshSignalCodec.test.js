import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MeshSignal } from './MeshSignal.js';

test('mesh signal stores WebRTC SDP payload as hex bytes', () => {
  const signal = MeshSignal.fromSession({
    kind: 'offer',
    flowId: 'flow-1',
    from: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    lobbyId: 'lobby',
    tableId: 'table',
    subscriptionLabel: 'inbound',
    channelLabel: 'outbound',
    sdp: 'v=0',
  });

  assert.match(signal.encryptedData, /^0x[0-9a-f]+$/);

  const parsed = MeshSignal.parse(signal);
  assert.equal(parsed.subscriptionLabel, 'inbound');
  assert.equal(parsed.channelLabel, 'outbound');
  assert.equal(parsed.sdp, 'v=0');
});
