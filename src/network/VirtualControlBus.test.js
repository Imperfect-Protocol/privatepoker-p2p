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
    config: { broadcastPrefix: 'privatepoker-p2p', peerId: 'parent-1', role: 'table' },
    handleControlMessage: (message, source) => received.push({ message, source }),
  };

  const bus = new VirtualControlBus(host);
  assert.equal(channel.channelName, 'privatepoker-p2p:parent-1:control');

  bus.post({ type: 'route-probe' });
  assert.deepEqual(channel.messages, [{ type: 'route-probe' }]);

  channel.onmessage({ data: { type: 'route-live' } });
  assert.deepEqual(received, [{ message: { type: 'route-live' }, source: 'local' }]);

  bus.close();
  assert.equal(channel.closed, true);
});

test('separate Lobby parent channels cannot read each other', () => {
  const channels = new Map();
  class TestBroadcastChannel {
    constructor(name) {
      this.name = name;
      this.listeners = channels.get(name) ?? new Set();
      this.listeners.add(this);
      channels.set(name, this.listeners);
    }

    postMessage(message) {
      this.listeners.forEach((listener) => {
        if (listener !== this) listener.onmessage?.({ data: message });
      });
    }

    close() {
      this.listeners.delete(this);
    }
  }
  const received = [];
  const session = (peerId) => {
    const host = {
      runtime: { BroadcastChannel: TestBroadcastChannel },
      address: { toString: () => '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      instanceId: peerId,
      config: { broadcastPrefix: 'privatepoker-p2p', peerId, role: 'table' },
      handleControlMessage: (message) => received.push({ peerId, message }),
    };
    return new VirtualControlBus(host);
  };
  const first = session('parent-1');
  const second = session('parent-2');

  first.post({ type: 'first-only' });
  assert.deepEqual(received, []);

  second.post({ type: 'second-only' });
  assert.deepEqual(received, []);

  first.close();
  second.close();
});
