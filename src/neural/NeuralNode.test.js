import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Tensor } from './Tensor.js';
import { HaarTransform } from './HaarTransform.js';
import { PathEmbedding } from './PathEmbedding.js';
import { NeuralNode } from './NeuralNode.js';
import { NeuralRoutingConfig } from './NeuralRoutingConfig.js';
import { NeuralSignal } from './NeuralSignal.js';

const flushTasks = async () => {
  for (let index = 0; index < 40; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

class FakeClock {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  now() {
    return this.time;
  }

  setTimer(callback, milliseconds) {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.time + Math.max(0, milliseconds), callback });
    return id;
  }

  clearTimer(id) {
    this.timers.delete(id);
  }

  async advance(milliseconds) {
    const target = this.time + milliseconds;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at);
      if (due.length === 0) break;
      const [id, timer] = due[0];
      this.timers.delete(id);
      this.time = timer.at;
      timer.callback();
      await flushTasks();
    }
    this.time = target;
  }
}

class InMemoryNetwork {
  constructor() {
    this.nodes = new Map();
    this.packets = [];
  }

  register(node) {
    this.nodes.set(node.address, node);
  }

  transportFor(address) {
    const self = this;
    return {
      sendBundle(destination, bundle) {
        self.packets.push({ from: address, to: destination, bundle });
        const target = self.nodes.get(destination);
        if (!target) return;
        void target.receive(bundle, address);
      },
      deliverControl(payload, from) {
        const target = self.nodes.get(address);
        target.delivered.push({ payload, from });
      },
      requestMeshFallback(target) {
        self.nodes.get(address).fallbacks.push(target);
      },
    };
  }
}

function makeNode(fields) {
  const config = new NeuralRoutingConfig({
    beaconIntervalMs: 60_000,
    announceRetryMs: 2_000,
    maxAnnounceAttempts: 0,
    traceEnabled: false,
    ...fields.config,
  });
  const node = new NeuralNode({
    address: fields.address,
    config,
    runtime: fields.clock,
    now: () => fields.clock.now(),
    neighbours: () => fields.neighbours,
    transport: fields.transport,
  });
  node.delivered = [];
  node.fallbacks = [];
  return node;
}

class LineNetwork {
  constructor() {
    this.clock = new FakeClock();
    this.network = new InMemoryNetwork();
    const addresses = ['0xaaa', '0xbbb', '0xccc'];
    this.a = makeNode({
      address: addresses[0], clock: this.clock, neighbours: [addresses[1]], transport: null,
    });
    this.b = makeNode({
      address: addresses[1], clock: this.clock, neighbours: [addresses[0], addresses[2]], transport: null,
    });
    this.c = makeNode({
      address: addresses[2], clock: this.clock, neighbours: [addresses[1]], transport: null,
    });
    this.a.transport = this.network.transportFor(this.a.address);
    this.b.transport = this.network.transportFor(this.b.address);
    this.c.transport = this.network.transportFor(this.c.address);
    this.network.register(this.a);
    this.network.register(this.b);
    this.network.register(this.c);
    this.a.start();
    this.b.start();
    this.c.start();
  }

  async run(milliseconds = 2_000) {
    await this.clock.advance(milliseconds);
    await flushTasks();
  }
}

test('Haar transform round-trips a dense tensor on every axis', () => {
  const haar = new HaarTransform();
  const shape = [8, 8, 8];
  const tensor = Tensor.fromArray(shape, Array.from({ length: 512 }, (_, index) => Math.sin(index)));
  const restored = haar.inverse(haar.forward(tensor));
  let maximumError = 0;
  for (let offset = 0; offset < tensor.size; offset += 1) {
    maximumError = Math.max(maximumError, Math.abs(tensor.data[offset] - restored.data[offset]));
  }
  assert.ok(maximumError < 1e-5, `round-trip error ${maximumError}`);
});

test('a path embedding twists inherited layers and pushes a fresh up arrow', () => {
  const embedding = PathEmbedding.self();
  const first = embedding.translated({ x: 1, y: 0 });
  assert.equal(first.at(0, 0), 1);
  const inherited = Array.from(first.profile(1));
  assert.ok(inherited[2] > 0.5, 'up arrow rotates a quarter turn clockwise');
  const second = first.translated({ x: 0, y: 1 });
  assert.equal(second.at(0, 0), 1);
  assert.ok(Math.abs(second.profile(1).reduce((sum, value) => sum + value, 0) - 1) < 1e-5);
  assert.ok(Math.abs(second.profile(2).reduce((sum, value) => sum + value, 0) - 1) < 1e-5);
});

test('an announce crosses a relay line, then its feedback returns home', async () => {
  const line = new LineNetwork();
  line.a.requestAnnounce('0xccc', { type: 'p2p-mst-announce' });
  await line.run(2_000);

  assert.equal(line.c.delivered.length, 1, 'announce payload reached the target');
  assert.equal(line.c.delivered[0].payload.type, 'p2p-mst-announce');
  assert.equal(line.a.metrics.feedbackDelivered, 1, 'feedback returned to the origin');
  assert.ok(line.b.metrics.signalsAccepted > 0);
  assert.ok(line.b.tensor.storedCombinations > 0, 'relay learned a route');
  assert.equal(line.a.metrics.signalsDroppedAsDuplicate, 0);
});

test('feedback teaches the origin a smart route for the next announce', async () => {
  const line = new LineNetwork();
  line.a.requestAnnounce('0xccc', { type: 'p2p-mst-announce' });
  await line.run(2_000);
  assert.equal(line.a.metrics.feedbackDelivered, 1);
  assert.ok(line.b.metrics.signalsAccepted > 0);
  assert.ok(line.b.tensor.storedCombinations > 0, 'relay learned a route');

  const epoch = line.a.timerFires;
  const probe = NeuralSignal.announce({
    originAddress: '0xaaa',
    targetAddress: '0xccc',
    sequenceId: 99,
    ttl: 8,
  });
  const choice = line.a.router.chooseDestinations(probe, line.a.connectedNeighbours, epoch);
  assert.deepEqual(choice.destinations, ['0xbbb']);
  assert.equal(choice.reason, 'learned');
});

test('a node without a route asks the transport for a mesh fallback', async () => {
  const line = new LineNetwork();
  line.a.requestAnnounce('0xddd', { type: 'p2p-mst-announce' });
  await line.run(5_000);
  assert.deepEqual(line.a.fallbacks, ['0xddd']);
  assert.equal(line.c.delivered.length, 0);
});

test('stun coalescing emits one bundle per neighbour', async () => {
  const line = new LineNetwork();
  for (let index = 0; index < 8; index += 1) {
    line.a.requestAnnounce('0xccc', { type: 'p2p-mst-announce', round: index });
  }
  await line.run(500);
  const fromA = line.network.packets.filter((packet) => packet.from === '0xaaa');
  assert.equal(fromA.length, 1, 'one outbound bundle for the whole burst');
  const announces = fromA[0].bundle.signals.filter((signal) => signal.kind === 'announce');
  assert.equal(announces.length, 1, 'retry copies coalesce semantically');
  assert.ok(fromA[0].bundle.signals.length <= 2, 'the beacon shares the same packet');
});
