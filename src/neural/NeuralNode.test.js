import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Tensor } from './Tensor.js';
import { HaarTransform } from './HaarTransform.js';
import { PathEmbedding } from './PathEmbedding.js';
import { BeaconPath } from './BeaconPath.js';
import { BeaconReminders } from './BeaconReminders.js';
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

function buildNetwork(clock, topology, config = {}) {
  const network = new InMemoryNetwork();
  const nodes = new Map();
  for (const address of Object.keys(topology)) {
    nodes.set(address, makeNode({
      address,
      clock,
      neighbours: topology[address],
      transport: null,
      config,
    }));
  }
  for (const [address, node] of nodes) {
    node.transport = network.transportFor(address);
    network.register(node);
  }
  for (const [address, neighbours] of Object.entries(topology)) {
    for (const neighbour of neighbours) nodes.get(address).confirmNeighbour(neighbour);
  }
  for (const node of nodes.values()) node.start();
  return { network, nodes };
}

const beaconsFrom = (network, from, to, origin) => network.packets
  .filter((packet) => packet.from === from && packet.to === to)
  .flatMap((packet) => packet.bundle.signals)
  .filter((signal) => signal.kind === 'beacon' && signal.originAddress === origin);

const pathKeys = (signals) => signals.flatMap((signal) => signal.paths.map((path) => path.join('>')));

test('a beacon path knows its next hop and whether it is an edge', () => {
  const route = new BeaconPath(['0xa', '0xb', '0xc']);
  assert.equal(route.isEdge, false);
  assert.equal(route.nextHopFrom('0xa'), '0xb');
  assert.equal(route.nextHopFrom('0xb'), '0xc');
  assert.equal(route.nextHopFrom('0xc'), null);
  assert.equal(BeaconPath.edge('0xa', '0xb').isEdge, true);
  assert.deepEqual(route.reversed().toArray(), ['0xc', '0xb', '0xa']);
});

test('reminders split the row: a cell only travels to its next hop', () => {
  let now = 0;
  const reminders = new BeaconReminders({
    address: '0xa',
    ttlMs: 1_000,
    now: () => now,
  });
  reminders.add(['0xa', '0xb']);
  reminders.add(['0xa', '0xc']);
  reminders.add(['0xa', '0xb', '0xd']);
  assert.deepEqual(reminders.pathsToward('0xb').map((path) => path.key), ['0xa>0xb', '0xa>0xb>0xd']);
  assert.deepEqual(reminders.pathsToward('0xc').map((path) => path.key), ['0xa>0xc']);
  assert.deepEqual(reminders.pathsToward('0xd'), []);
  assert.equal(reminders.add(['0xb', '0xa']), false, 'only the row owner advertises a path');
  reminders.removeNeighbour('0xb');
  assert.deepEqual(reminders.pathsToward('0xb'), []);
  now = 2_000;
  assert.deepEqual(reminders.pathsToward('0xc'), [], 'reminders expire unless renewed');
});

test('an origin advertises each own-row cell only to its next hop', async () => {
  const clock = new FakeClock();
  const built = buildNetwork(clock, {
    '0xaaa': ['0xbbb', '0xccc', '0xddd'],
    '0xbbb': ['0xaaa'],
    '0xccc': ['0xaaa'],
    '0xddd': ['0xaaa'],
  }, { beaconIntervalMs: 80, routeReminderTtlMs: 2_000 });
  // D stays connected but has no live cell in A's row; presence must still flow.
  built.nodes.get('0xaaa').reminders.removeNeighbour('0xddd');
  await clock.advance(600);
  await flushTasks();

  const toB = pathKeys(beaconsFrom(built.network, '0xaaa', '0xbbb', '0xaaa'));
  const toC = pathKeys(beaconsFrom(built.network, '0xaaa', '0xccc', '0xaaa'));
  const toD = pathKeys(beaconsFrom(built.network, '0xaaa', '0xddd', '0xaaa'));
  assert.ok(toB.includes('0xaaa>0xbbb'), `B received its cell: ${toB}`);
  assert.ok(!toB.includes('0xaaa>0xccc'), `B must not receive C's cell: ${toB}`);
  assert.ok(toC.includes('0xaaa>0xccc'), `C received its cell: ${toC}`);
  assert.deepEqual(toD, [], 'a neighbour with no matching cell receives presence only');
});

test('a relayed row merges at the node and never returns to its sender', async () => {
  const clock = new FakeClock();
  const built = buildNetwork(clock, {
    '0xaaa': ['0xxx'],
    '0xxx': ['0xaaa', '0xnnn'],
    '0xnnn': ['0xxx', '0xyy'],
    '0xbbb': ['0xyy'],
    '0xyy': ['0xbbb', '0xnnn'],
  }, { beaconIntervalMs: 80, routeReminderTtlMs: 2_000 });
  await clock.advance(900);
  await flushTasks();

  const relayedToY = beaconsFrom(built.network, '0xnnn', '0xyy', '0xaaa');
  const relayedToX = pathKeys(beaconsFrom(built.network, '0xnnn', '0xxx', '0xaaa'));
  assert.ok(relayedToY.length > 0, 'the relay forwarded A row toward Y');
  assert.deepEqual(relayedToX, [], 'A row is never reflected to the neighbour it arrived from');
  assert.ok(built.nodes.get('0xnnn').metrics.rowsRewarded > 0, 'arrival rewarded the whole row');
});

test('two equal announce routes both survive and both are remembered', async () => {
  const clock = new FakeClock();
  const built = buildNetwork(clock, {
    '0xaaa': ['0xccc', '0xddd'],
    '0xccc': ['0xaaa', '0xkkk'],
    '0xddd': ['0xaaa', '0xkkk'],
    '0xkkk': ['0xccc', '0xddd', '0xbbb'],
    '0xbbb': ['0xkkk'],
  }, { beaconIntervalMs: 60_000, maxAnnounceAttempts: 0 });

  built.nodes.get('0xaaa').requestAnnounce('0xbbb', { type: 'p2p-mst-announce' });
  await clock.advance(2_000);
  await flushTasks();

  assert.ok(built.nodes.get('0xbbb').delivered.length >= 1, 'the target received the request');
  assert.ok(
    built.nodes.get('0xbbb').metrics.feedbackGenerated >= 2,
    'the target answered every distinct arrival path',
  );
  const routes = [...built.nodes.get('0xaaa').reminders.entries.keys()];
  assert.ok(routes.some((route) => route.startsWith('0xaaa>0xccc')), `C branch kept: ${routes}`);
  assert.ok(routes.some((route) => route.startsWith('0xaaa>0xddd')), `D branch kept: ${routes}`);
  assert.ok(
    built.nodes.get('0xaaa').metrics.feedbackDelivered >= 2,
    'both routes returned feedback to the origin',
  );
});
