import { clearDetachedTimer, setDetachedTimer } from './Timers.js';

/**
 * Sigmoid stun duration, from 50 ms toward a 500 ms saturation limit.
 *
 * More coalesced signals buy a longer window, so a busy node emits fewer, full
 * bundles instead of one packet per arriving signal.
 */
export function sigmoidStunningDelay(count, options = {}) {
  const k = options.k ?? 0.1;
  const midpoint = options.midpoint ?? 20;
  const minimum = options.minimumMs ?? 50;
  const maximum = options.maximumMs ?? 500;
  if (count < 1) throw new Error('stun message count must be at least 1');
  const exponent = Math.max(-60, Math.min(60, -k * (count - midpoint)));
  return minimum + (maximum - minimum) / (1 + Math.exp(exponent));
}

/**
 * A single replaceable timer per node.
 *
 * The first accepted signal anchors the window; later arrivals update the
 * duration but never move the anchor, so continuous traffic cannot postpone the
 * flush forever. Receiving never sends: only this timer flushes.
 */
export class StunWindow {
  constructor(fields) {
    this.runtime = fields.runtime;
    this.config = fields.config;
    this.trace = fields.trace;
    this.onFlush = fields.onFlush;
    this.now = fields.now ?? (() => Date.now());
    this.timer = null;
    this.anchor = null;
    this.count = 0;
    this.lastDelay = 0;
  }

  get stunned() {
    return this.anchor !== null;
  }

  get messagesInCluster() {
    return this.count;
  }

  /** Accept `accepted` signals that arrived at `at`. */
  arrive(at, accepted = 1) {
    if (accepted <= 0) return;
    if (this.anchor === null) this.anchor = at;
    this.count += accepted;
    this.lastDelay = sigmoidStunningDelay(this.count, this.config.stun);
    this.#arm(this.anchor + this.lastDelay);
    this.trace?.trace('armed', {
      count: this.count,
      delayMs: Math.round(this.lastDelay * 100) / 100,
      anchor: this.anchor,
    });
  }

  /** A local request with nothing pending still flushes on the next tick. */
  flushSoon() {
    if (this.anchor === null) this.anchor = this.now();
    this.#arm(this.anchor);
  }

  close() {
    if (this.timer !== null) clearDetachedTimer(this.runtime, this.timer);
    this.timer = null;
    this.anchor = null;
    this.count = 0;
  }

  reset() {
    if (this.timer !== null) clearDetachedTimer(this.runtime, this.timer);
    this.timer = null;
    this.anchor = null;
    this.count = 0;
  }

  #arm(deadline) {
    if (this.timer !== null) clearDetachedTimer(this.runtime, this.timer);
    const delay = Math.max(0, deadline - this.now());
    this.timer = setDetachedTimer(this.runtime, () => {
      this.timer = null;
      this.onFlush?.();
    }, delay);
  }
}
