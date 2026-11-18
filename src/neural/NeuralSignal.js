import { BeaconPath } from './BeaconPath.js';
import { PathEmbedding } from './PathEmbedding.js';

/**
 * The four protocol signal kinds.
 *
 * - beacon: presence plus the origin's path reminders.
 * - announce: discovery of a target, retried until answered.
 * - relay: one addressed control message travelling over a route an announce
 *   already found. Each relay has its own identity, so consecutive messages on
 *   the same route are never mistaken for retries of one another.
 * - feedback: the reverse-route reward for an announce.
 */
export class SignalKind {
  static beacon = 'beacon';

  static announce = 'announce';

  static relay = 'relay';

  static feedback = 'feedback';

  static isKnown(kind) {
    return kind === SignalKind.beacon
      || kind === SignalKind.announce
      || kind === SignalKind.relay
      || kind === SignalKind.feedback;
  }
}

/**
 * One logical signal with lossless metadata and a fuzzy path embedding.
 *
 * Exact identity (`originAddress`, `targetAddress`, `sequenceId`, `ttl`) travels
 * beside the compressed embedding. The embedding may be blurred and resampled;
 * these fields never are.
 */
export class NeuralSignal {
  constructor(fields) {
    this.kind = fields.kind;
    if (!SignalKind.isKnown(this.kind)) {
      throw new Error(`Unknown neural signal kind ${this.kind}`);
    }
    this.embedding = fields.embedding ?? PathEmbedding.self();
    this.embeddingDepth = NeuralSignal.#depth(fields.embeddingDepth ?? 1);
    this.originAddress = String(fields.originAddress);
    this.targetAddress = fields.targetAddress === null || fields.targetAddress === undefined
      ? null
      : String(fields.targetAddress);
    this.sequenceId = Number(fields.sequenceId ?? 0);
    this.hopCount = Number(fields.hopCount ?? 0);
    this.visited = [...(fields.visited ?? [])].map(String);
    this.coefficient = Number(fields.coefficient ?? 1);
    this.routeAttempt = Number(fields.routeAttempt ?? 0);
    this.ttl = Number(fields.ttl ?? 8);
    this.routePath = [...(fields.routePath ?? [])].map(String);
    this.returnPath = [...(fields.returnPath ?? [])].map(String);
    this.paths = [...(fields.paths ?? [])].map((path) => BeaconPath.from(path));
    this.payload = fields.payload ?? null;
  }

  get signalId() {
    return [
      this.kind,
      this.originAddress,
      this.targetAddress ?? '',
      this.sequenceId,
    ].join(':');
  }

  /**
   * Coalescing key. Announce retries of A->B are one semantic request; relays are
   * one message each; feedback is keyed by the request it acknowledges; beacons
   * merge by origin and sequence.
   */
  get key() {
    if (this.kind === SignalKind.announce) {
      return `${this.kind}:${this.originAddress}:${this.targetAddress}`;
    }
    if (this.kind === SignalKind.relay) {
      return `${this.kind}:${this.originAddress}:${this.targetAddress}:${this.sequenceId}`;
    }
    if (this.kind === SignalKind.feedback) {
      return `${this.kind}:${this.originAddress}:${this.targetAddress}:${this.sequenceId}:${this.routePath.join('>')}`;
    }
    return `${this.kind}:${this.originAddress}:${this.sequenceId}`;
  }

  /**
   * Bundle identity. An announce keeps one packet row per arrival path even
   * though all of them are one semantic request for retry/coalescing purposes.
   */
  get bundleKey() {
    if (this.kind === SignalKind.announce) {
      return `${this.key}|${this.visited.join('>')}`;
    }
    return this.key;
  }

  withPaths(paths) {
    return new NeuralSignal({
      ...this.metadata(),
      paths,
      embedding: this.embedding,
    });
  }

  /** A routing probe for one cell of a beacon row: same row, named destination. */
  withTarget(targetAddress) {
    return new NeuralSignal({
      ...this.metadata(),
      targetAddress,
      embedding: this.embedding,
    });
  }

  withEmbedding(embedding, embeddingDepth = this.embeddingDepth) {
    return new NeuralSignal({
      ...this.metadata(),
      embedding,
      embeddingDepth,
      payload: this.payload,
    });
  }

  withHopCount(hopCount) {
    return new NeuralSignal({
      ...this.metadata(),
      hopCount,
      embedding: this.embedding,
    });
  }

  /** Hop-localised copy: rotate/translate handled by the receiver. */
  forwardedBy(address, fields = {}) {
    const feedback = this.kind === SignalKind.feedback;
    return new NeuralSignal({
      ...this.metadata(),
      embedding: this.embedding,
      hopCount: this.hopCount + 1,
      visited: feedback ? this.visited : [...this.visited, String(address)],
      returnPath: feedback ? this.returnPath.slice(1) : this.returnPath,
      ttl: fields.ttlEnabled ? this.ttl - 1 : this.ttl,
      coefficient: this.coefficient * fields.coefficientDecay,
    });
  }

  metadata() {
    return {
      kind: this.kind,
      originAddress: this.originAddress,
      targetAddress: this.targetAddress,
      sequenceId: this.sequenceId,
      hopCount: this.hopCount,
      embeddingDepth: this.embeddingDepth,
      visited: this.visited,
      coefficient: this.coefficient,
      routeAttempt: this.routeAttempt,
      ttl: this.ttl,
      routePath: this.routePath,
      returnPath: this.returnPath,
      paths: this.paths.map((path) => path.toArray()),
      payload: this.payload,
    };
  }

  static fromMetadata(fields) {
    return new NeuralSignal({ ...fields, embedding: PathEmbedding.self() });
  }

  static beacon({ originAddress, sequenceId, ttl, paths }) {
    return new NeuralSignal({
      kind: SignalKind.beacon,
      originAddress,
      sequenceId,
      ttl,
      paths,
      embedding: PathEmbedding.self(),
      embeddingDepth: 1,
    });
  }

  static relay({ originAddress, targetAddress, sequenceId, ttl, payload }) {
    return new NeuralSignal({
      kind: SignalKind.relay,
      originAddress,
      targetAddress,
      sequenceId,
      ttl,
      payload,
      embedding: PathEmbedding.self(),
      embeddingDepth: 1,
    });
  }

  static announce({ originAddress, targetAddress, sequenceId, ttl, payload, routeAttempt = 0 }) {
    return new NeuralSignal({
      kind: SignalKind.announce,
      originAddress,
      targetAddress,
      sequenceId,
      ttl,
      routeAttempt,
      embedding: PathEmbedding.self(),
      embeddingDepth: 1,
      payload,
    });
  }

  static feedbackFor(announce, selfAddress, ttl) {
    const forwardPath = [...announce.visited, selfAddress];
    const returnPath = [...forwardPath.slice(0, -1)].reverse();
    return new NeuralSignal({
      kind: SignalKind.feedback,
      originAddress: announce.originAddress,
      targetAddress: selfAddress,
      sequenceId: announce.sequenceId,
      ttl: Math.min(ttl, returnPath.length),
      embedding: announce.embedding,
      embeddingDepth: announce.embeddingDepth,
      routePath: forwardPath,
      returnPath,
    });
  }

  static #depth(value) {
    const depth = Math.trunc(Number(value));
    if (!Number.isFinite(depth) || depth < 1 || depth > PathEmbedding.HOP_BINS) {
      throw new Error(`embeddingDepth must be in [1, ${PathEmbedding.HOP_BINS}]; got ${value}`);
    }
    return depth;
  }
}
