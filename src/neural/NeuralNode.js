import { NeuralSignal, SignalKind } from './NeuralSignal.js';
import { NeuralRoutingConfig } from './NeuralRoutingConfig.js';
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
 * Receiving only learns, coalesces and arms the stun window. All outbound work
 * happens in `flush()` when the window closes, which emits at most one bundle
 * per selected neighbour. That single rule is what turns a flood into a routed
 * stream of bundles.
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
    this.pendingDiscoveries = new Map();
    this.seenSignals = new Map();
    this.awaitingAnnounces = new Map();
    this.nextBeaconSequence = 0;
    this.nextAnnounceSequence = 0;
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
      announcesSent: 0,
      feedbackGenerated: 0,
      discoveriesDelivered: 0,
      feedbackDelivered: 0,
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
   * Build this node's beacon if it is due. Beacons are created inside the timer
   * flush so they share one packet with pending announces and relays.
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
    this.coalesce(signal);
    if (!this.stun.stunned) this.stun.flushSoon();
  }

  /** A direct WebRTC edge formed: confirm the direction toward that peer. */
  confirmNeighbour(peerAddress) {
    const peer = String(peerAddress);
    this.awaitingAnnounces.delete(peer);
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
    this.trace?.debug('neighbour.removed', { peer: String(peerAddress) });
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
      const previous = this.seenSignals.get(signal.key);
      const isFirst = previous === undefined;
      const betterPath = previous !== undefined && signal.hopCount < previous.hops;
      const broaderRetry = previous !== undefined && signal.routeAttempt > previous.attempt;
      if (previous !== undefined && !(betterPath || broaderRetry)) {
        this.metrics.signalsDroppedAsDuplicate += 1;
        this.trace?.trace('receive.duplicate', { signal: signal.signalId, sender });
        continue;
      }
      this.seenSignals.set(signal.key, {
        hops: isFirst || betterPath ? signal.hopCount : previous.hops,
        attempt: Math.max(previous?.attempt ?? 0, signal.routeAttempt),
      });
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
        isFirst,
        betterPath,
        broaderRetry,
      });

      this.applyLocally(localized, sender, isFirst || betterPath);
      if (isFirst || betterPath) this.metrics.signalsAccepted += 1;
      accepted += 1;
    }

    if (accepted === 0) return;
    this.stun.arrive(now, accepted);
    this.metrics.maxClusterSize = Math.max(this.metrics.maxClusterSize, this.stun.messagesInCluster);
  }

  applyLocally(signal, sender, fresh) {
    if (signal.kind === SignalKind.feedback) {
      if (fresh) this.applySuccessFeedbackReward(signal);
      if (signal.originAddress === this.address && signal.returnPath.length === 0) {
        if (signal.targetAddress !== null) this.awaitingAnnounces.delete(signal.targetAddress);
        this.metrics.feedbackDelivered += 1;
        this.trace?.debug('feedback.delivered', { signal: signal.signalId });
        return;
      }
      this.coalesce(signal);
      return;
    }

    if (signal.kind === SignalKind.announce && signal.targetAddress === this.address) {
      const previous = this.pendingDiscoveries.get(signal.originAddress);
      if (previous === undefined || signal.hopCount < previous.hopCount) {
        this.pendingDiscoveries.set(signal.originAddress, signal);
      }
      this.trace?.debug('announce.discovered', {
        origin: signal.originAddress,
        hopCount: signal.hopCount,
        payloadType: signal.payload?.type ?? null,
      });
      return;
    }

    if (signal.kind === SignalKind.beacon && fresh) {
      this.applyEmbeddingReward(signal, sender, signal.hopCount);
    }
    this.coalesce(signal);
  }

  coalesce(signal) {
    const current = this.pendingSignals.get(signal.key);
    if (current === undefined
      || signal.routeAttempt > current.routeAttempt
      || (signal.routeAttempt === current.routeAttempt && signal.hopCount < current.hopCount)) {
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
      const pending = this.pendingSignals.size + this.pendingDiscoveries.size;
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
    const work = [...this.pendingSignals.values()];
    this.pendingSignals.clear();

    for (const announce of this.pendingDiscoveries.values()) {
      this.metrics.discoveriesDelivered += 1;
      this.trace?.debug('announce.deliver', {
        origin: announce.originAddress,
        hopCount: announce.hopCount,
        payloadType: announce.payload?.type ?? null,
      });
      if (announce.payload) {
        this.transport.deliverControl(announce.payload, announce.originAddress);
      }
      const feedback = NeuralSignal.feedbackFor(announce, this.address, this.config.ttl);
      work.push(feedback);
      this.metrics.feedbackGenerated += 1;
    }
    this.pendingDiscoveries.clear();

    this.addDueRetries(work);
    const beacon = this.takeDueBeacon();
    if (beacon !== null) work.push(beacon);
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
      work.push(retry);
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
    for (const signal of work) {
      if (signal.kind === SignalKind.announce && signal.targetAddress === this.address) continue;
      if (signal.hopCount >= this.config.maxHops) {
        this.metrics.signalsDroppedHopLimit += 1;
        continue;
      }
      if (this.config.ttlEnabled && signal.ttl <= 0) {
        this.metrics.signalsDroppedTtl += 1;
        continue;
      }
      const choice = this.router.chooseDestinations(signal, neighbours, this.timerFires);
      for (const destination of choice.destinations) {
        const forwarded = signal.forwardedBy(this.address, {
          ttlEnabled: this.config.ttlEnabled,
          coefficientDecay: this.config.coefficientDecay,
        });
        const bucket = byDestination.get(destination) ?? new Map();
        const previous = bucket.get(forwarded.key);
        bucket.set(
          forwarded.key,
          previous === undefined ? forwarded : SignalRouter.preferBundledItem(previous, forwarded),
        );
        byDestination.set(destination, bucket);
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
