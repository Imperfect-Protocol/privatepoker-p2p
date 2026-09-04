import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VirtualNetwork } from './VirtualNetwork.js';

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
