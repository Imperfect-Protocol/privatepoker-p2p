import { Tensor } from './Tensor.js';
import { PathEmbedding } from './PathEmbedding.js';

const ANGLE_BINS = PathEmbedding.ANGLE_BINS;
const HOP_BINS = PathEmbedding.HOP_BINS;
const TIME_DEPTH = 8;
const LOGICAL_SHAPE = [ANGLE_BINS, HOP_BINS, ANGLE_BINS, HOP_BINS, ANGLE_BINS, TIME_DEPTH];

/**
 * The eight-slot time history for one (source, target, neighbour) key.
 * A new epoch resets the slot before adding, so a slot never mixes epochs.
 */
class TimeHistory {
  constructor(baseline) {
    this.values = new Float32Array(TIME_DEPTH).fill(baseline);
    this.epochs = new Int32Array(TIME_DEPTH).fill(-1);
  }

  reward(epoch, amount, baseline, maxWeight) {
    const slot = ((Math.trunc(epoch) % TIME_DEPTH) + TIME_DEPTH) % TIME_DEPTH;
    if (this.epochs[slot] !== epoch) {
      this.values[slot] = baseline;
      this.epochs[slot] = epoch;
    }
    const previous = this.values[slot];
    const next = Math.min(maxWeight, previous + amount);
    this.values[slot] = next;
    return Math.max(0, next - previous);
  }

  score(epoch, baseline, decay, maxWeight) {
    let learned = 0;
    for (let slot = 0; slot < TIME_DEPTH; slot += 1) {
      if (this.epochs[slot] < 0) continue;
      const age = Math.max(0, epoch - this.epochs[slot]);
      learned += (this.values[slot] - baseline) * decay ** age;
    }
    return Math.min(maxWeight, baseline + learned);
  }

  hasValidSlot() {
    return this.epochs.some((epoch) => epoch >= 0);
  }
}

/**
 * Sparse logical Source(8x8) x Target(8x8) x Neighbour(8x1) x Time(8).
 *
 * Only observed combinations allocate a time history. Scoring decays older
 * observations by `coefficientDecay`; with learning disabled the logical tensor
 * is an implicit unit tensor, so every route scores 1.0 without allocation.
 */
export class SparseHebbianTensor {
  constructor(fields = {}) {
    this.timeDepth = fields.timeDepth ?? TIME_DEPTH;
    this.learningEnabled = fields.learningEnabled ?? true;
    this.baseline = this.learningEnabled ? (fields.baseline ?? 0.1) : 1.0;
    this.maxWeight = fields.maxWeight ?? 5.0;
    this.decay = fields.coefficientDecay ?? 0.97;
    this.histories = new Map();
    this.rewardTotal = 0;
    this.updatesSinceFilter = 0;
    this.waveletFilterPasses = 0;
    this.lastCoefficientCount = 0;
  }

  get storedCombinations() {
    return this.histories.size;
  }

  reward(source, target, neighbour, epoch, amount) {
    if (!this.learningEnabled || amount <= 0) return;
    const key = SparseHebbianTensor.#key(source, target, neighbour);
    const history = this.histories.get(key) ?? new TimeHistory(this.baseline);
    this.histories.set(key, history);
    this.rewardTotal += history.reward(epoch, amount, this.baseline, this.maxWeight);
    this.updatesSinceFilter += 1;
  }

  score(source, target, neighbour, epoch) {
    if (!this.learningEnabled) return 1.0;
    const history = this.histories.get(SparseHebbianTensor.#key(source, target, neighbour));
    if (!history) return this.baseline;
    return history.score(epoch, this.baseline, this.decay, this.maxWeight);
  }

  /**
   * Denoise the logical 8^6 tensor, then project back onto observed keys and
   * epochs. Noise can never invent an unobserved protocol fact.
   */
  denoise(pipeline, options = {}) {
    if (!this.learningEnabled || this.updatesSinceFilter <= 0 || this.histories.size === 0) {
      return { coefficientCount: 0, pruned: 0 };
    }
    const dense = Tensor.zeros(LOGICAL_SHAPE);
    const validByKey = new Map();
    this.histories.forEach((history, key) => {
      const base = SparseHebbianTensor.#baseCoordinates(key);
      const valid = history.epochs.map((epoch) => epoch >= 0);
      if (!valid.some(Boolean)) return;
      validByKey.set(key, valid);
      valid.forEach((isValid, slot) => {
        if (!isValid) return;
        dense.data[dense.shape.offset([...base, slot])] = history.values[slot] - this.baseline;
      });
    });
    if (validByKey.size === 0) {
      this.updatesSinceFilter = 0;
      return { coefficientCount: 0, pruned: 0 };
    }

    const composed = pipeline.composeWithCount(dense);
    let pruned = 0;
    const removed = [];
    validByKey.forEach((valid, key) => {
      const history = this.histories.get(key);
      const base = SparseHebbianTensor.#baseCoordinates(key);
      valid.forEach((isValid, slot) => {
        if (!isValid) return;
        const reconstructed = composed.tensor.at(...base, slot);
        const value = Math.min(
          this.maxWeight,
          Math.max(this.baseline, this.baseline + reconstructed),
        );
        if (value - this.baseline < (options.pruneThreshold ?? 0.00005)) {
          history.values[slot] = this.baseline;
          history.epochs[slot] = -1;
          pruned += 1;
        } else {
          history.values[slot] = value;
        }
      });
      if (!history.hasValidSlot()) removed.push(key);
    });
    removed.forEach((key) => this.histories.delete(key));

    this.waveletFilterPasses += 1;
    this.lastCoefficientCount = composed.coefficientCount;
    this.updatesSinceFilter = 0;
    return { coefficientCount: composed.coefficientCount, pruned };
  }

  static #key(source, target, neighbour) {
    return ((((source[0] * HOP_BINS + source[1]) * ANGLE_BINS + target[0]) * HOP_BINS + target[1]) * ANGLE_BINS) + neighbour;
  }

  static #baseCoordinates(key) {
    const neighbour = key % ANGLE_BINS;
    let rest = Math.floor(key / ANGLE_BINS);
    const targetHop = rest % HOP_BINS;
    rest = Math.floor(rest / HOP_BINS);
    const targetAngle = rest % ANGLE_BINS;
    rest = Math.floor(rest / ANGLE_BINS);
    const sourceHop = rest % HOP_BINS;
    const sourceAngle = Math.floor(rest / HOP_BINS);
    return [sourceAngle, sourceHop, targetAngle, targetHop, neighbour];
  }
}
