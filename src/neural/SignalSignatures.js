import { AngleSpace, SpatialAddressSpace } from './PathEmbedding.js';
import { PathEmbedding } from './PathEmbedding.js';

/**
 * Fuzzy Source/Target/Neighbour signatures used by the sparse Hebbian tensor.
 *
 * Source is an (angle, hop) profile taken from the signal's translated path
 * embedding. Target is only a hash-derived direction hint with an unknown hop.
 * A neighbour is an angle with no hop dimension at all.
 */
export class SignalSignatures {
  constructor(fields = {}) {
    this.address = String(fields.address);
    this.angleSpace = fields.angleSpace ?? new AngleSpace(PathEmbedding.ANGLE_BINS);
    this.addressSpace = fields.addressSpace ?? new SpatialAddressSpace();
  }

  sourceWeights(signal) {
    const hop = Math.min(Math.max(Math.trunc(signal.hopCount), 0), PathEmbedding.HOP_BINS - 1);
    let profile = signal.embedding.profile(hop);
    if (SignalSignatures.#mass(profile) <= 1e-10) {
      profile = SignalSignatures.#angleTotals(signal.embedding);
    }
    return SignalSignatures.#profileWeights(profile).map(([angle, weight]) => [[angle, hop], weight]);
  }

  /**
   * Target is a single hash-derived direction hint with an unknown hop. A
   * connection request is exactly that point, so no override is needed.
   */
  targetWeights(signal) {
    return this.angleSpace.fuzzyWeights(this.#deltaTo(signal.targetAddress ?? signal.originAddress))
      .map((entry) => [[entry.bin, 0], entry.weight]);
  }

  /**
   * A beacon is a whole row: every target position carries the same observation,
   * so the row is scored as the uniform average over all target directions.
   */
  rowWeights() {
    const weight = 1 / PathEmbedding.ANGLE_BINS;
    return Array.from(
      { length: PathEmbedding.ANGLE_BINS },
      (_, bin) => [[bin, 0], weight],
    );
  }

  neighbourWeights(neighbourAddress) {
    return this.angleSpace.fuzzyWeights(this.#deltaTo(neighbourAddress))
      .map((entry) => [entry.bin, entry.weight]);
  }

  #deltaTo(address) {
    const key = String(address);
    if (key === this.address) return { x: 0, y: 0 };
    return this.addressSpace.delta(this.address, key);
  }

  static #mass(profile) {
    let total = 0;
    for (let index = 0; index < profile.length; index += 1) total += profile[index];
    return total;
  }

  static #angleTotals(embedding) {
    const totals = new Float32Array(PathEmbedding.ANGLE_BINS);
    for (let hop = 0; hop < PathEmbedding.HOP_BINS; hop += 1) {
      for (let angle = 0; angle < PathEmbedding.ANGLE_BINS; angle += 1) {
        totals[angle] += embedding.at(angle, hop);
      }
    }
    return totals;
  }

  /**
   * Keep a small normalized fuzzy neighbourhood: the top three bins that carry
   * at least 18% of the strongest bin's weight.
   */
  static #profileWeights(profile, maxBins = 3) {
    const values = Array.from(profile, (value) => Math.max(0, value));
    let maximum = 0;
    values.forEach((value) => { maximum = Math.max(maximum, value); });
    if (maximum <= 1e-12) return [[0, 1]];
    const cutoff = maximum * 0.18;
    const selected = values
      .map((value, index) => ({ index, value }))
      .filter((entry) => entry.value >= cutoff)
      .sort((left, right) => right.value - left.value)
      .slice(0, maxBins);
    const total = selected.reduce((sum, entry) => sum + entry.value, 0);
    if (total <= 1e-12) return [[selected[0].index, 1]];
    return selected.map((entry) => [entry.index, entry.value / total]);
  }
}
