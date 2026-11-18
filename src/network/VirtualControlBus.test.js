import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VirtualControlBus } from './VirtualControlBus.js';
import { VirtualNetworkRuntime } from './VirtualNetworkRuntime.js';

test('network runtime exposes only the broadcast transport', () => {
  const runtime = new VirtualNetworkRuntime();

  assert.deepEqual(Object.keys(runtime), [
    'setTimer',
    'clearTimer',
    'crypto',
    'RTCPeerConnection',
    'BroadcastChannel',
  ]);
});

test('control bus exchanges messages only through BroadcastChannel', () => {
  let channel = null;
  class TestBroadcastChannel {
    constructor(channelName) {
      this.channelName = channelName;
      this.messages = [];
      this.closed = false;
      channel = this;
    }

    postMessage(message) {
      this.messages.push(message);
    }

    close() {
      this.closed = true;
    }
  }

  const received = [];
  const host = {
    runtime: { BroadcastChannel: TestBroadcastChannel },
    address: { toString: () => '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    instanceId: 'test-instance',
    config: { broadcastPrefix: 'privatepoker-p2p', role: 'table' },
    handleControlMessage: (message, source) => received.push({ message, source }),
  };

  const bus = new VirtualControlBus(host);
  assert.equal(channel.channelName, 'privatepoker-p2p:control');

  bus.post({ type: 'route-probe' });
  assert.deepEqual(channel.messages, [{ type: 'route-probe' }]);

  channel.onmessage({ data: { type: 'route-live' } });
  assert.deepEqual(received, [{ message: { type: 'route-live' }, source: 'local' }]);

  bus.close();
  assert.equal(channel.closed, true);
});
