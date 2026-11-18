/**
 * One immutable bag of neural-routing knobs. Defaults mirror the Python
 * simulator so the JS client can be compared against it directly.
 */
export class NeuralRoutingConfig {
  constructor(fields = {}) {
    this.angleBins = fields.angleBins ?? 8;
    this.hopBins = fields.hopBins ?? 8;
    this.timeDepth = fields.timeDepth ?? 8;
    this.ttl = fields.ttl ?? 8;
    this.maxHops = fields.maxHops ?? 128;
    this.forwardingThreshold = fields.forwardingThreshold ?? 0.20;
    this.coefficientDecay = fields.coefficientDecay ?? 0.97;
    this.hebbianReward = fields.hebbianReward ?? 0.35;
    this.maxWeight = fields.maxWeight ?? 5.0;
    this.baselineWeight = fields.baselineWeight ?? 0.1;
    this.learningEnabled = fields.learningEnabled ?? true;
    this.noiseEnabled = fields.noiseEnabled ?? true;
    this.haarEnabled = fields.haarEnabled ?? true;
    this.gaussianEnabled = fields.gaussianEnabled ?? true;
    this.compressionEnabled = fields.compressionEnabled ?? true;
    this.ttlEnabled = fields.ttlEnabled ?? true;
    this.twistEnabled = fields.twistEnabled ?? true;
    this.noiseStrength = fields.noiseStrength ?? 0.00001;
    this.gaussianWidth = fields.gaussianWidth ?? 0.30;
    this.messageThreshold = fields.messageThreshold ?? 0.006;
    this.nodeThreshold = fields.nodeThreshold ?? 0.00005;
    this.nodePruneThreshold = fields.nodePruneThreshold ?? 0.00005;
    this.beaconIntervalMs = fields.beaconIntervalMs ?? 1_000;
    this.routeReminderTtlMs = fields.routeReminderTtlMs
      ?? Math.max(4_000, this.beaconIntervalMs * 4);
    this.maxRouteReminders = fields.maxRouteReminders ?? 64;
    this.announceSpacingMs = fields.announceSpacingMs ?? 250;
    this.fallbackTimeoutMs = fields.fallbackTimeoutMs ?? 5_000;
    this.maxAnnounceAttempts = fields.maxAnnounceAttempts ?? 2;
    this.announceRetryMs = fields.announceRetryMs ?? 2_000;
    this.nodeWaveletEveryNTimers = fields.nodeWaveletEveryNTimers ?? 8;
    this.traceEnabled = fields.traceEnabled ?? true;
    this.stun = {
      k: fields.stun?.k ?? 0.1,
      midpoint: fields.stun?.midpoint ?? 20,
      minimumMs: fields.stun?.minimumMs ?? 50,
      maximumMs: fields.stun?.maximumMs ?? 500,
    };
    this.seed = fields.seed ?? null;
  }

  validate() {
    if (this.angleBins !== 8 || this.hopBins !== 8 || this.timeDepth !== 8) {
      throw new Error('the compact embedding is fixed at angle x hop = 8x8, with 8 time slots');
    }
    if (this.forwardingThreshold < 0) {
      throw new Error('forwardingThreshold must be non-negative');
    }
    if (this.fallbackTimeoutMs <= 0) {
      throw new Error('fallbackTimeoutMs must be positive');
    }
    return this;
  }
}
