import { NeuralSignal, SignalKind } from './NeuralSignal.js';
import { NeuralRoutingConfig } from './NeuralRoutingConfig.js';
import { BeaconReminders } from './BeaconReminders.js';
import { PathEmbedding } from './PathEmbedding.js';
import { SparseHebbianTensor } from './SparseHebbianTensor.js';
import { SignalSignatures } from './SignalSignatures.js';
import { SignalRouter } from './SignalRouter.js';
import { StunWindow } from './StunWindow.js';
import { clearDetachedTimer, setDetachedTimer } from './Timers.js';
import { EmbeddingTensorCodec } from './EmbeddingTensorCodec.js';
import { SparseCoefficientCodec } from './SparseCoefficientCodec.js';
import { createWaveletPipeline } from './WaveletPipeline.js';
import { GaussianRandom } from './GaussianRandom.js';

const BEACON_REWARD = 0.12;
const FEEDBACK_REWARD = 0.35;
const DEFAULT_HEBBIAN_REWARD = 0.35;
const MAX_SEEN_SIGNALS = 4096;

/**
 * One node of the neural overlay.
 *
 * Receiving only learns, merges and arms the stun window. All outbound work
 * happens in `flush()` when the window closes, which emits at most one bundle
 * per selected neighbour. That single rule is what turns a flood into a routed
 * stream of bundles.
 *
 * Three signal shapes have three different tensor effects:
 *
 * - an announce or relay is a point `A->B`, so it rewards exactly that cell;
 * - a beacon is a row `A->*`, so it rewards every target position of A's row
 *   for the direction it travelled;
 * - feedback is the reverse-route reward for a point that succeeded.
 *
 * Beacons merge by origin (the row), announces merge by semantic request but
 * keep one copy per arrival path, and relays keep their own identity so two
 * consecutive messages are never mistaken for retries.
 */
export class NeuralNode {
  constructor(fields) {
    this.address = String(fields.address);
    this.instanceId = fields.instanceId ?? null;
    this.config = fields.config instanceof NeuralRoutingConfig ? fields.config : new NeuralRoutingConfig(fields.config);
    this.runtime = fields.runtime;
    this.trace = fields.trace;
    this.transport = fields.transport;
    this.neighbours = fields.neighbours;
    this.now = fields.now ?? (() => Date.now());
    this.random = fields.random ?? GaussianRandom.fromSeed(this.config.seed ?? (Date.now() & 0xffffffff));

    this.embedding = PathEmbedding.self();
    this.tensor = new SparseHebbianTensor({
      timeDepth: this.config.timeDepth,
      learningEnabled: this.config.learningEnabled,
      baseline: this.config.baselineWeight,
      maxWeight: this.config.maxWeight,
      coefficientDecay: this.config.coefficientDecay,
    });
    this.signatures = new SignalSignatures({ address: this.address });
    this.router = new SignalRouter({
      address: this.address,
      config: this.config,
      signatures: this.signatures,
      tensor: this.tensor,
      trace: this.trace,
    });
    this.codec = new EmbeddingTensorCodec({
      pipeline: createWaveletPipeline(this.config, { random: this.random }),
      sparseCodec: new SparseCoefficientCodec({ compressed: this.config.compressionEnabled }),
      trace: this.trace,
    });
    this.nodePipeline = createWaveletPipeline(this.config, {
      threshold: this.config.nodeThreshold,
      random: this.random,
    });

    this.active = false;
    this.wakeTimer = null;
    this.pendingSignals = new Map();
    this.pendingAnnounces = new Map();
    this.pendingBeacons = new Map();
    this.pendingRelays = new Map();
    this.pendingDiscoveries = new Map();
    this.seenSignals = new Map();
    this.awaitingAnnounces = new Map();
    this.reminders = new BeaconReminders({
      address: this.address,
      ttlMs: this.config.routeReminderTtlMs,
      maxPaths: this.config.maxRouteReminders,
      now: this.now,
    });
    this.nextBeaconSequence = 0;
    this.nextAnnounceSequence = 0;
    this.nextRelaySequence = 0;
    this.lastBeaconAt = null;
    this.timerFires = 0;
    this.flushing = false;

    this.stun = new StunWindow({
      runtime: this.runtime,
      config: this.config,
      trace: this.trace?.child('stun'),
      now: this.now,
      onFlush: () => { void this.flush(); },
    });

    this.metrics = {
      bundlesReceived: 0,
      signalsReceived: 0,
      signalsAccepted: 0,
      signalsDroppedAsDuplicate: 0,
      signalsDroppedTtl: 0,
      signalsDroppedHopLimit: 0,
      packetsSent: 0,
      signalCopiesSent: 0,
      beaconsSent: 0,
      beaconsMerged: 0,
      rowsRewarded: 0,
      announcesSent: 0,
      relaysSent: 0,
      relaysDelivered: 0,
      feedbackGenerated: 0,
      discoveriesDelivered: 0,
      feedbackDelivered: 0,
      pathsAdvertised: 0,
      maxBundleSizeSent: 0,
      maxClusterSize: 0,
    };
  }

  get connectedNeighbours() {
    return (this.neighbours?.() ?? []).map(String);
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.trace?.debug('node.start', { neighbours: this.connectedNeighbours });
    this.scheduleNextWake();
  }

  stop() {
    this.active = false;
    this.clearWake();
    this.stun.close();
    this.pendingSignals.clear();
    this.pendingAnnounces.clear();
    this.pendingBeacons.clear();
    this.pendingRelays.clear();
    this.pendingDiscoveries.clear();
    this.awaitingAnnounces.clear();
    this.trace?.debug('node.stop', { metrics: this.metrics });
  }

  clearWake() {
    if (this.wakeTimer !== null) clearDetachedTimer(this.runtime, this.wakeTimer);
    this.wakeTimer = null;
  }

  /** The single beacon/retry wake timer. The stun window owns the flush timer. */
  wake() {
    if (!this.active) return;
    const now = this.now();
    const beaconDue = this.#beaconDue(now);
    const retryDue = [...this.awaitingAnnounces.values()].some((entry) => entry.deadline <= now + 1);
    if (beaconDue || retryDue) this.stun.flushSoon();
    if (!this.stun.stunned) this.scheduleNextWake();
  }

  #beaconDue(now) {
    return this.lastBeaconAt === null || now + 1 >= this.lastBeaconAt + this.config.beaconIntervalMs;
  }

  /**
   * Build this node's row beacon if it is due. The row paths are attached per
   * destination during routing; this only creates the presence signal.
   */
  takeDueBeacon() {
    if (!this.active) return null;
    const now = this.now();
    if (!this.#beaconDue(now)) return null;
    this.lastBeaconAt = now;
    const beacon = NeuralSignal.beacon({
      originAddress: this.address,
      sequenceId: this.nextBeaconSequence,
      ttl: this.config.ttl,
    });
    this.nextBeaconSequence += 1;
    this.metrics.beaconsSent += 1;
    this.trace?.trace('beacon.emit', { sequenceId: beacon.sequenceId });
    return beacon;
  }

  /**
   * Queue an addressed announce and, if the route is unknown, arm the mesh
   * fallback for when the announce retries are exhausted.
   */
  requestAnnounce(targetAddress, payload) {
    if (!this.active) return;
    const target = String(targetAddress);
    if (target === this.address) return;
    const existing = this.awaitingAnnounces.get(target);
    const signal = NeuralSignal.announce({
      originAddress: this.address,
      targetAddress: target,
      sequenceId: this.nextAnnounceSequence,
      ttl: this.config.ttl,
      payload,
      routeAttempt: existing?.attempt ?? 0,
    });
    this.nextAnnounceSequence += 1;
    this.trace?.debug('announce.request', {
      target,
      sequenceId: signal.sequenceId,
      attempt: signal.routeAttempt,
      payloadType: payload?.type ?? null,
    });
    this.coalesceAnnounce(signal);
    if (!this.stun.stunned) this.stun.flushSoon();
  }

  /** Queue one addressed control message; each relay is its own point. */
  requestRelay(targetAddress, payload) {
    if (!this.active) return;
    const target = String(targetAddress);
    if (target === this.address) return;
    const signal = NeuralSignal.relay({
      originAddress: this.address,
      targetAddress: target,
      sequenceId: this.nextRelaySequence,
      ttl: this.config.ttl,
      payload,
    });
    this.nextRelaySequence += 1;
    this.metrics.relaysSent += 1;
    this.trace?.debug('relay.request', {
      target,
      sequenceId: signal.sequenceId,
      payloadType: payload?.type ?? null,
    });
    this.coalesceSignal(signal);
    if (!this.stun.stunned) this.stun.flushSoon();
  }

  /** A direct WebRTC edge formed: add the edge to our row and confirm direction. */
  confirmNeighbour(peerAddress) {
    const peer = String(peerAddress);
    this.awaitingAnnounces.delete(peer);
    this.reminders.add([this.address, peer]);
    const signal = new NeuralSignal({
      kind: SignalKind.beacon,
      originAddress: peer,
      sequenceId: 0,
      ttl: this.config.ttl,
      embedding: PathEmbedding.self(),
      embeddingDepth: 1,
    });
    this.applyEmbeddingReward(signal, peer, 0);
    this.trace?.debug('neighbour.confirmed', {
      peer,
      storedCombinations: this.tensor.storedCombinations,
      rewardTotal: Math.round(this.tensor.rewardTotal * 1000) / 1000,
    });
  }

  /** Warm-start the tensor for a neighbour the transport already trusts. */
  neighbourRemoved(peerAddress) {
    const peer = String(peerAddress);
    this.reminders.removeNeighbour(peer);
    this.trace?.debug('neighbour.removed', { peer });
  }

  /**
   * Receive one decoded bundle from the immediate sender.
   *
   * Decoding, translation and learning are async only because DEFLATE uses
   * platform streams; the protocol effects themselves stay ordered.
   */
  async receive(bundle, senderAddress) {
    if (!this.active) {
      return;
    }
    const sender = String(senderAddress);
    if (!bundle?.signals?.length || !bundle.tensor) return;
    try {
      await this.#receiveBundle(bundle, sender);
    } catch (error) {
      this.trace?.debug('receive.failed', {
        sender,
        error: error?.message ?? String(error),
      });
    }
  }

  async #receiveBundle(bundle, sender) {
    this.metrics.bundlesReceived += 1;
    this.metrics.signalsReceived += bundle.signals.length;

    const receivedSignals = bundle.signals.map((metadata) => NeuralSignal.fromMetadata(metadata));
    const decoded = await this.codec.decode(bundle.tensor, receivedSignals);
    if (!decoded.ok) {
      this.trace?.debug('receive.decode-failed', {
        sender,
        error: decoded.error?.message ?? String(decoded.error),
      });
      return;
    }

    const offset = this.signatures.addressSpace.delta(sender, this.address);
    const now = this.now();
    let accepted = 0;
    for (let index = 0; index < receivedSignals.length; index += 1) {
      const signal = receivedSignals[index];
      const embedding = decoded.value[index];
      if (signal.hopCount > this.config.maxHops) {
        this.metrics.signalsDroppedHopLimit += 1;
        continue;
      }
      const seenKey = this.#seenKey(signal, sender);
      if (this.seenSignals.has(seenKey)) {
        this.metrics.signalsDroppedAsDuplicate += 1;
        this.trace?.trace('receive.duplicate', { signal: signal.signalId, sender });
        continue;
      }
      this.seenSignals.set(seenKey, true);
      this.pruneSeenSignals();

      const depth = Math.min(PathEmbedding.HOP_BINS, signal.embeddingDepth + 1);
      const localized = signal.withEmbedding(
        embedding.translated(offset, {
          twist: this.config.twistEnabled,
          smooth: this.config.gaussianEnabled,
        }).normalized(depth),
        depth,
      );
      this.trace?.trace('receive.signal', {
        sender,
        kind: localized.kind,
        signal: localized.signalId,
        hopCount: localized.hopCount,
        depth,
        ttl: localized.ttl,
        paths: localized.paths.length,
      });

      this.applyLocally(localized, sender);
      this.metrics.signalsAccepted += 1;
      accepted += 1;
    }

    if (accepted === 0) return;
    this.stun.arrive(now, accepted);
    this.metrics.maxClusterSize = Math.max(this.metrics.maxClusterSize, this.stun.messagesInCluster);
  }

  /**
   * Duplicate identity per arrival path. A row beacon is keyed by its sender, an
   * announce by the exact path it travelled, a relay by its message id and
   * feedback by its route.
   */
  #seenKey(signal, sender) {
    if (signal.kind === SignalKind.beacon) return `${signal.key}|${sender}`;
    if (signal.kind === SignalKind.announce) return `${signal.bundleKey}|${sender}`;
    return signal.key;
  }

  applyLocally(signal, sender) {
    if (signal.kind === SignalKind.feedback) {
      this.applySuccessFeedbackReward(signal);
      if (signal.originAddress === this.address && signal.returnPath.length === 0) {
        if (signal.targetAddress !== null) this.awaitingAnnounces.delete(signal.targetAddress);
        this.reminders.rememberRoute(signal.routePath);
        this.metrics.feedbackDelivered += 1;
        this.trace?.debug('feedback.delivered', { signal: signal.signalId });
        return;
      }
      this.coalesceSignal(signal);
      return;
    }

    if (signal.kind === SignalKind.announce) {
      if (signal.targetAddress === this.address) {
        this.rememberDiscovery(signal);
        return;
      }
      this.coalesceAnnounce(signal);
      return;
    }

    if (signal.kind === SignalKind.relay) {
      if (signal.targetAddress === this.address) {
        this.pendingRelays.set(signal.key, signal);
        return;
      }
      this.coalesceSignal(signal);
      return;
    }

    this.mergeBeacon(signal, sender);
    this.applyRowReward(signal, sender, signal.hopCount);
    this.metrics.beaconsMerged += 1;
  }

  /**
   * A targeted announce arrived. Keep one copy per distinct arrival path: two
   * equal routes that converge must both survive, so the target returns feedback
   * down both and both branches are reinforced.
   */
  rememberDiscovery(signal) {
    const key = signal.key;
    const entry = this.pendingDiscoveries.get(key) ?? { paths: new Map() };
    const pathKey = [...signal.visited, this.address].join('>');
    const current = entry.paths.get(pathKey);
    if (current === undefined || signal.hopCount < current.hopCount) {
      entry.paths.set(pathKey, signal);
    }
    this.pendingDiscoveries.set(key, entry);
    this.reminders.rememberRoute([...signal.visited, this.address].reverse());
    this.trace?.debug('announce.discovered', {
      origin: signal.originAddress,
      hopCount: signal.hopCount,
      paths: entry.paths.size,
      payloadType: signal.payload?.type ?? null,
    });
  }

  /** Relays and feedback keep one copy per logical message. */
  coalesceSignal(signal) {
    const current = this.pendingSignals.get(signal.key);
    if (current === undefined || signal.hopCount < current.hopCount) {
      this.pendingSignals.set(signal.key, signal);
      this.trace?.trace('signal.coalesce', {
        key: signal.key,
        queue: this.pendingSignals.size,
        replaced: current !== undefined,
      });
      return;
    }
    this.trace?.trace('signal.coalesce.kept', { key: signal.key, queue: this.pendingSignals.size });
  }

  /**
   * Annonces merge by semantic request, but keep one copy per arrival path. A
   * broader retry clears the paths of weaker attempts.
   */
  coalesceAnnounce(signal) {
    const key = signal.key;
    const entry = this.pendingAnnounces.get(key) ?? { attempt: signal.routeAttempt, paths: new Map() };
    if (signal.routeAttempt > entry.attempt) {
      entry.paths.clear();
      entry.attempt = signal.routeAttempt;
    }
    if (signal.routeAttempt < entry.attempt) return;
    const pathKey = signal.visited.join('>');
    const current = entry.paths.get(pathKey);
    if (current === undefined || signal.hopCount < current.hopCount) {
      entry.paths.set(pathKey, signal);
    }
    this.pendingAnnounces.set(key, entry);
    this.trace?.trace('announce.coalesce', {
      key,
      attempt: entry.attempt,
      paths: entry.paths.size,
    });
  }

  /** Merge a received row into this window's copy of that origin's row. */
  mergeBeacon(signal, sender) {
    const entry = this.pendingBeacons.get(signal.originAddress)
      ?? { signal, arrivals: new Set(), paths: new Map() };
    entry.arrivals.add(sender);
    if (signal.hopCount < entry.signal.hopCount
      || (signal.hopCount === entry.signal.hopCount && signal.sequenceId > entry.signal.sequenceId)) {
      entry.signal = signal;
    }
    for (const path of signal.paths) {
      if (path.nodes[0] === signal.originAddress) entry.paths.set(path.key, path);
    }
    this.pendingBeacons.set(signal.originAddress, entry);
    this.trace?.trace('beacon.merge', {
      origin: signal.originAddress,
      arrivals: [...entry.arrivals],
      paths: entry.paths.size,
    });
  }

  /** Point reward: one source cell, one target cell, one neighbour. */
  applyEmbeddingReward(signal, forwardNeighbourAddress, forwardHop) {
    if (!this.config.learningEnabled) return;
    const learningSignal = signal.withHopCount(forwardHop ?? signal.hopCount);
    const sources = this.signatures.sourceWeights(learningSignal);
    const targets = this.signatures.targetWeights(learningSignal);
    const neighbours = this.signatures.neighbourWeights(forwardNeighbourAddress);
    const rewardScale = this.config.hebbianReward / DEFAULT_HEBBIAN_REWARD;
    const base = signal.kind === SignalKind.beacon ? BEACON_REWARD : FEEDBACK_REWARD;
    const reward = base * rewardScale * signal.coefficient
      / (1 + 0.25 * Math.max(0, learningSignal.hopCount));
    sources.forEach(([source, sourceWeight]) => {
      targets.forEach(([target, targetWeight]) => {
        neighbours.forEach(([neighbour, neighbourWeight]) => {
          this.tensor.reward(
            source,
            target,
            neighbour,
            this.timerFires,
            reward * sourceWeight * targetWeight * neighbourWeight,
          );
        });
      });
    });
    this.trace?.trace('tensor.reward', {
      kind: signal.kind,
      signal: signal.signalId,
      neighbour: String(forwardNeighbourAddress),
      reward: Math.round(reward * 10000) / 10000,
      combinations: this.tensor.storedCombinations,
    });
  }

  /**
   * Row reward: a beacon `A->*` reinforces every target position of A's row for
   * the direction it travelled. Eventually different columns settle on different
   * next hops, but one arrival updates the whole row at once.
   */
  applyRowReward(signal, forwardNeighbourAddress, forwardHop) {
    if (!this.config.learningEnabled) return;
    const learningSignal = signal.withHopCount(forwardHop ?? signal.hopCount);
    const sources = this.signatures.sourceWeights(learningSignal);
    const targets = this.signatures.rowWeights();
    const neighbours = this.signatures.neighbourWeights(forwardNeighbourAddress);
    const rewardScale = this.config.hebbianReward / DEFAULT_HEBBIAN_REWARD;
    const reward = BEACON_REWARD * rewardScale * signal.coefficient
      / (1 + 0.25 * Math.max(0, learningSignal.hopCount));
    sources.forEach(([source, sourceWeight]) => {
      targets.forEach(([target, targetWeight]) => {
        neighbours.forEach(([neighbour, neighbourWeight]) => {
          this.tensor.reward(
            source,
            target,
            neighbour,
            this.timerFires,
            reward * sourceWeight * targetWeight * neighbourWeight,
          );
        });
      });
    });
    this.metrics.rowsRewarded += 1;
    this.trace?.trace('tensor.row-reward', {
      origin: signal.originAddress,
      neighbour: String(forwardNeighbourAddress),
      reward: Math.round(reward * 10000) / 10000,
      combinations: this.tensor.storedCombinations,
    });
  }

  applySuccessFeedbackReward(signal) {
    const index = signal.routePath.indexOf(this.address);
    if (index < 0 || index >= signal.routePath.length - 1) return;
    const forwardNeighbour = signal.routePath[index + 1];
    if (!this.connectedNeighbours.includes(forwardNeighbour)) return;
    this.applyEmbeddingReward(signal, forwardNeighbour, index);
  }

  async flush() {
    if (!this.active) return;
    if (this.flushing) {
      this.flushPending = true;
      return;
    }
    this.flushing = true;
    this.stun.reset();
    this.timerFires += 1;
    try {
      this.denoiseNodeTensor();
      const pending = this.pendingSignals.size
        + this.pendingAnnounces.size
        + this.pendingBeacons.size
        + this.pendingRelays.size
        + this.pendingDiscoveries.size;
      const work = this.collectWork();
      this.trace?.debug('flush.start', {
        timerFires: this.timerFires,
        pending,
        work: work.length,
        neighbours: this.connectedNeighbours.length,
      });
      if (work.length === 0) return;
      const byDestination = this.routeWork(work);
      for (const destination of [...byDestination.keys()].sort()) {
        await this.sendBundle(destination, byDestination.get(destination));
      }
    } finally {
      this.flushing = false;
      if (this.flushPending) {
        this.flushPending = false;
        this.stun.flushSoon();
      }
      this.scheduleNextWake();
    }
  }

  collectWork() {
    const work = [];
    for (const signal of this.pendingSignals.values()) {
      work.push({ signal, arrivals: null, own: false });
    }
    this.pendingSignals.clear();

    for (const announce of this.pendingAnnounces.values()) {
      for (const signal of announce.paths.values()) {
        work.push({ signal, arrivals: null, own: false });
      }
    }
    this.pendingAnnounces.clear();

    for (const entry of this.pendingBeacons.values()) {
      work.push({ signal: entry.signal, arrivals: entry.arrivals, own: false, paths: entry.paths });
    }
    this.pendingBeacons.clear();

    for (const discovery of this.pendingDiscoveries.values()) {
      const paths = [...discovery.paths.values()].sort((left, right) => left.hopCount - right.hopCount);
      const representative = paths[0];
      this.metrics.discoveriesDelivered += 1;
      this.trace?.debug('announce.deliver', {
        origin: representative.originAddress,
        hopCount: representative.hopCount,
        paths: paths.length,
        payloadType: representative.payload?.type ?? null,
      });
      if (representative.payload) {
        this.transport.deliverControl(representative.payload, representative.originAddress);
      }
      for (const signal of paths) {
        work.push({
          signal: NeuralSignal.feedbackFor(signal, this.address, this.config.ttl),
          arrivals: null,
          own: false,
        });
        this.metrics.feedbackGenerated += 1;
      }
    }
    this.pendingDiscoveries.clear();

    for (const relay of this.pendingRelays.values()) {
      this.metrics.relaysDelivered += 1;
      this.trace?.debug('relay.deliver', {
        origin: relay.originAddress,
        sequenceId: relay.sequenceId,
        payloadType: relay.payload?.type ?? null,
      });
      if (relay.payload) {
        this.transport.deliverControl(relay.payload, relay.originAddress);
      }
    }
    this.pendingRelays.clear();

    this.addDueRetries(work);
    const beacon = this.takeDueBeacon();
    if (beacon !== null) {
      work.push({ signal: beacon, arrivals: new Set(), own: true, paths: this.reminders.row() });
    }
    return work;
  }

  addDueRetries(work) {
    const neighbours = this.connectedNeighbours;
    const now = this.now();
    for (const [target, entry] of [...this.awaitingAnnounces.entries()]) {
      if (neighbours.includes(target)) {
        this.awaitingAnnounces.delete(target);
        continue;
      }
      if (now + 1 < entry.deadline) continue;
      if (entry.attempt >= this.config.maxAnnounceAttempts) {
        this.awaitingAnnounces.delete(target);
        this.trace?.debug('announce.exhausted', { target, attempts: entry.attempt });
        this.transport.requestMeshFallback(target);
        continue;
      }
      const retry = NeuralSignal.announce({
        originAddress: this.address,
        targetAddress: target,
        sequenceId: this.nextAnnounceSequence,
        ttl: this.config.ttl,
        routeAttempt: entry.attempt + 1,
        payload: entry.payload,
      });
      this.nextAnnounceSequence += 1;
      work.push({ signal: retry, arrivals: null, own: false });
      this.awaitingAnnounces.set(target, {
        deadline: this.#announceRetryDeadline(),
        attempt: entry.attempt + 1,
        sequenceId: retry.sequenceId,
        payload: entry.payload,
      });
      this.trace?.debug('announce.retry', { target, attempt: entry.attempt + 1 });
    }
  }

  /**
   * One retry deadline. The default equals the simulator's
   * `max(2, 2 * beaconInterval)` (2 s with a 1 s beacon clock).
   */
  #announceRetryDeadline() {
    return this.now() + this.config.announceRetryMs;
  }

  /**
   * The origin arms a retry deadline when an announce actually leaves the node,
   * mirroring the simulator: routing is what makes an attempt observable.
   */
  noteAnnounceAttempt(signal) {
    if (signal.kind !== SignalKind.announce) return;
    if (signal.originAddress !== this.address || signal.targetAddress === null) return;
    const existing = this.awaitingAnnounces.get(signal.targetAddress);
    if (existing !== undefined && signal.routeAttempt < existing.attempt) return;
    this.awaitingAnnounces.set(signal.targetAddress, {
      deadline: this.#announceRetryDeadline(),
      attempt: signal.routeAttempt,
      sequenceId: signal.sequenceId,
      payload: signal.payload,
    });
    this.metrics.announcesSent += 1;
  }

  routeWork(work) {
    const neighbours = this.connectedNeighbours;
    const byDestination = new Map();
    for (const entry of work) {
      const signal = entry.signal;
      if (signal.kind === SignalKind.announce && signal.targetAddress === this.address) continue;
      if (signal.kind === SignalKind.relay && signal.targetAddress === this.address) continue;
      if (signal.hopCount >= this.config.maxHops) {
        this.metrics.signalsDroppedHopLimit += 1;
        continue;
      }
      if (this.config.ttlEnabled && signal.ttl <= 0) {
        this.metrics.signalsDroppedTtl += 1;
        continue;
      }
      if (signal.kind === SignalKind.beacon) {
        this.routeBeaconRow(entry, neighbours, byDestination);
        continue;
      }
      const choice = this.router.chooseDestinations(signal, neighbours, this.timerFires);
      for (const destination of choice.destinations) {
        this.addToBundle(byDestination, destination, signal);
      }
      this.noteAnnounceAttempt(signal);
      this.trace?.trace('route.choice', {
        signal: signal.signalId,
        kind: signal.kind,
        destinations: choice.destinations,
        reason: choice.reason,
        smart: choice.smart,
      });
    }
    return this.materializeBundles(byDestination);
  }

  /**
   * Split one row into per-neighbour copies.
   *
   * This node's own row goes out exactly as described: each cell only to its
   * next hop, presence to everyone else. A forwarded row is tensor-gated as a
   * whole, and any reminder that continues through this node also keeps its
   * explicit next hop so the route does not stall. The arrival neighbour is
   * excluded before either rule runs; reflection is never a routing outcome.
   */
  routeBeaconRow(entry, neighbours, byDestination) {
    const available = neighbours.filter((neighbour) => !(entry.arrivals?.has(neighbour) ?? false));
    if (available.length === 0) return;
    const row = entry.signal;
    const selected = new Map();

    const select = (destination, path) => {
      const paths = selected.get(destination) ?? new Map();
      if (path !== null) paths.set(path.key, path);
      selected.set(destination, paths);
    };

    if (entry.own) {
      for (const destination of available) select(destination, null);
      for (const path of entry.paths.values()) {
        const nextHop = path.nextHopFrom(this.address);
        if (nextHop !== null && available.includes(nextHop)) select(nextHop, path);
      }
    } else {
      const gated = this.router.chooseDestinations(row, available, this.timerFires);
      for (const destination of gated.destinations) select(destination, null);
      for (const path of entry.paths.values()) {
        const endpoint = path.nodes[path.nodes.length - 1];
        if (endpoint === this.address) continue;
        const probe = row.withTarget(endpoint);
        const cell = this.router.chooseDestinations(probe, available, this.timerFires);
        for (const destination of cell.destinations) select(destination, path);
        const nextHop = path.nextHopFrom(this.address);
        if (nextHop !== null && available.includes(nextHop)) select(nextHop, path);
      }
    }

    for (const [destination, paths] of selected) {
      this.addToBundle(byDestination, destination, row.withPaths([...paths.values()]));
      this.metrics.pathsAdvertised += paths.size;
      if (!entry.own) this.applyRowReward(row, destination, row.hopCount);
    }
    this.trace?.trace('beacon.split', {
      origin: row.originAddress,
      own: entry.own,
      available,
      destinations: [...selected.keys()],
      arrival: [...(entry.arrivals ?? [])],
    });
  }

  addToBundle(byDestination, destination, signal) {
    const forwarded = signal.forwardedBy(this.address, {
      ttlEnabled: this.config.ttlEnabled,
      coefficientDecay: this.config.coefficientDecay,
    });
    const bucket = byDestination.get(destination) ?? new Map();
    const previous = bucket.get(forwarded.bundleKey);
    bucket.set(
      forwarded.bundleKey,
      previous === undefined ? forwarded : SignalRouter.preferBundledItem(previous, forwarded),
    );
    byDestination.set(destination, bucket);
  }

  materializeBundles(byDestination) {
    const bundles = new Map();
    for (const [destination, bucket] of byDestination) {
      bundles.set(destination, [...bucket.values()]);
    }
    return bundles;
  }

  async sendBundle(destination, signals) {
    if (signals.length === 0) return;
    const ordered = [...signals].sort(NeuralNode.#bundleOrder);
    let encoded;
    try {
      encoded = await this.codec.encode(ordered);
    } catch (error) {
      this.trace?.debug('bundle.encode-failed', {
        destination,
        error: error?.message ?? String(error),
      });
      return;
    }
    if (!encoded.ok) {
      this.trace?.debug('bundle.encode-failed', {
        destination,
        error: encoded.error?.message ?? String(encoded.error),
      });
      return;
    }
    this.metrics.packetsSent += 1;
    this.metrics.signalCopiesSent += ordered.length;
    this.metrics.maxBundleSizeSent = Math.max(this.metrics.maxBundleSizeSent, ordered.length);
    this.trace?.debug('bundle.send', {
      destination,
      signals: ordered.length,
      kinds: [...new Set(ordered.map((signal) => signal.kind))],
      paths: ordered.reduce((total, signal) => total + signal.paths.length, 0),
      coefficientCount: encoded.value.coefficientCount,
      codec: encoded.value.codec,
    });
    this.transport.sendBundle(destination, {
      sourceAddress: this.address,
      signals: ordered.map((signal) => signal.metadata()),
      tensor: encoded.value,
    });
  }

  denoiseNodeTensor() {
    if (!this.config.learningEnabled) return;
    if (this.tensor.updatesSinceFilter <= 0) return;
    if (this.timerFires % this.config.nodeWaveletEveryNTimers !== 0) return;
    const result = this.tensor.denoise(this.nodePipeline, {
      pruneThreshold: this.config.nodePruneThreshold,
    });
    this.trace?.debug('tensor.denoise', {
      coefficientCount: result.coefficientCount,
      pruned: result.pruned,
      storedCombinations: this.tensor.storedCombinations,
      passes: this.tensor.waveletFilterPasses,
    });
  }

  scheduleNextWake() {
    if (!this.active) return;
    this.clearWake();
    const now = this.now();
    const nextBeacon = (this.lastBeaconAt ?? now) + this.config.beaconIntervalMs;
    const retryTimes = [...this.awaitingAnnounces.values()]
      .map((entry) => entry.deadline)
      .filter((deadline) => deadline > now + 1);
    const deadline = Math.max(now, Math.min(nextBeacon, ...(retryTimes.length > 0 ? retryTimes : [nextBeacon])));
    this.wakeTimer = setDetachedTimer(this.runtime, () => {
      this.wakeTimer = null;
      this.wake();
    }, Math.max(0, deadline - now));
    this.trace?.trace('wake.scheduled', { inMs: Math.max(0, deadline - now) });
  }

  pruneSeenSignals() {
    if (this.seenSignals.size <= MAX_SEEN_SIGNALS) return;
    const excess = this.seenSignals.size - MAX_SEEN_SIGNALS;
    const iterator = this.seenSignals.keys();
    for (let index = 0; index < excess; index += 1) {
      this.seenSignals.delete(iterator.next().value);
    }
  }

  static #bundleOrder(left, right) {
    const leftKey = [left.kind, left.originAddress, left.targetAddress ?? '', left.sequenceId,
      left.hopCount, left.routeAttempt];
    const rightKey = [right.kind, right.originAddress, right.targetAddress ?? '', right.sequenceId,
      right.hopCount, right.routeAttempt];
    for (let index = 0; index < leftKey.length; index += 1) {
      if (leftKey[index] < rightKey[index]) return -1;
      if (leftKey[index] > rightKey[index]) return 1;
    }
    return 0;
  }
}
