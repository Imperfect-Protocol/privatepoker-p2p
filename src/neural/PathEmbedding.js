const TWO_PI = 2 * Math.PI;

/** A deterministic point for an address, used only as a fuzzy direction hint. */
export class SpatialAddressSpace {
  constructor() {
    this.cache = new Map();
  }

  pointOf(address) {
    const key = String(address).toLowerCase();
    if (!this.cache.has(key)) {
      const digest = SpatialAddressSpace.#digest(key);
      this.cache.set(key, {
        x: (digest[0] % 10000) / 100,
        y: (digest[1] % 10000) / 100,
      });
    }
    return this.cache.get(key);
  }

  delta(fromAddress, toAddress) {
    const from = this.pointOf(fromAddress);
    const to = this.pointOf(toAddress);
    return { x: to.x - from.x, y: to.y - from.y };
  }

  /** Two independent 32-bit FNV-1a lanes; deterministic across browsers. */
  static #digest(text) {
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193) >>> 0;
      second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
    }
    return [first, second];
  }
}

/**
 * Circular angle arithmetic. Convention: zero points up (+Y), positive angles
 * rotate clockwise toward +X, so the angle is atan2(dx, dy).
 */
export class AngleSpace {
  constructor(bins = 8) {
    this.bins = bins;
  }

  radians(delta) {
    if (Math.hypot(delta.x, delta.y) < 1e-12) return 0;
    return (Math.atan2(delta.x, delta.y) % TWO_PI + TWO_PI) % TWO_PI;
  }

  bin(delta) {
    return Math.floor((this.radians(delta) / TWO_PI) * this.bins) % this.bins;
  }

  fuzzyWeights(delta) {
    if (Math.hypot(delta.x, delta.y) < 1e-12) {
      return [{ bin: 0, weight: 1 }];
    }
    const coordinate = (this.radians(delta) / TWO_PI) * this.bins;
    const lower = Math.floor(coordinate);
    const fraction = coordinate - lower;
    const lowerBin = ((lower % this.bins) + this.bins) % this.bins;
    const upperBin = (lowerBin + 1) % this.bins;
    if (fraction < 1e-8) return [{ bin: lowerBin, weight: 1 }];
    return [
      { bin: lowerBin, weight: 1 - fraction },
      { bin: upperBin, weight: fraction },
    ];
  }

  rotate(profile, radians) {
    const shift = ((radians % TWO_PI) + TWO_PI) % TWO_PI * this.bins / TWO_PI;
    const whole = Math.floor(shift);
    const fraction = shift - whole;
    const rotated = new Float32Array(this.bins);
    for (let bin = 0; bin < this.bins; bin += 1) {
      const first = profile[((bin - whole) % this.bins + this.bins) % this.bins];
      const second = profile[((bin - whole - 1) % this.bins + this.bins) % this.bins];
      rotated[bin] = first * (1 - fraction) + second * fraction;
    }
    return PathEmbedding.renormalize(profile, rotated);
  }

  smooth(profile, sigma = 0.42) {
    if (sigma <= 0) return profile;
    const taps = [-2, -1, 0, 1, 2];
    const weights = taps.map((tap) => Math.exp(-0.5 * (tap / sigma) ** 2));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const smoothed = new Float32Array(this.bins);
    taps.forEach((tap, index) => {
      for (let bin = 0; bin < this.bins; bin += 1) {
        const source = ((bin - tap) % this.bins + this.bins) % this.bins;
        smoothed[bin] += profile[source] * (weights[index] / total);
      }
    });
    return PathEmbedding.renormalize(profile, smoothed);
  }
}

/**
 * The compact 8 x 8 angle x hop embedding. Layer zero is always the receiving
 * node's canonical up-arrow. On each hop every occupied layer is rotated by the
 * signed edge angle, shifted one layer down, and a fresh up-arrow is inserted.
 */
export class PathEmbedding {
  static ANGLE_BINS = 8;

  static HOP_BINS = 8;

  constructor(values = null) {
    this.values = values ?? new Float32Array(PathEmbedding.ANGLE_BINS * PathEmbedding.HOP_BINS);
    this.angles = new AngleSpace(PathEmbedding.ANGLE_BINS);
  }

  static self() {
    const embedding = new PathEmbedding();
    embedding.values[0] = 1;
    return embedding;
  }

  get depth() {
    return this.#estimatedDepth();
  }

  at(angle, hop) {
    return this.values[angle + hop * PathEmbedding.ANGLE_BINS];
  }

  set(angle, hop, value) {
    this.values[angle + hop * PathEmbedding.ANGLE_BINS] = value;
  }

  profile(hop) {
    return this.values.subarray(hop * PathEmbedding.ANGLE_BINS, (hop + 1) * PathEmbedding.ANGLE_BINS);
  }

  clone() {
    return new PathEmbedding(this.values.slice());
  }

  normalized(depth, fallbackDirection = 0) {
    const values = Float32Array.from(this.values, (value) => Math.max(0, value));
    const occupiedDepth = Math.max(1, Math.min(depth, PathEmbedding.HOP_BINS));
    for (let hop = occupiedDepth; hop < PathEmbedding.HOP_BINS; hop += 1) {
      values.fill(0, hop * PathEmbedding.ANGLE_BINS, (hop + 1) * PathEmbedding.ANGLE_BINS);
    }
    values.fill(0, 0, PathEmbedding.ANGLE_BINS);
    values[0] = 1;
    for (let hop = 1; hop < occupiedDepth; hop += 1) {
      const start = hop * PathEmbedding.ANGLE_BINS;
      const end = start + PathEmbedding.ANGLE_BINS;
      let mass = 0;
      for (let index = start; index < end; index += 1) mass += values[index];
      if (mass > 1e-10) {
        for (let index = start; index < end; index += 1) values[index] /= mass;
      } else {
        values.fill(0, start, end);
        values[(fallbackDirection % PathEmbedding.ANGLE_BINS) + start] = 1;
      }
    }
    return new PathEmbedding(values);
  }

  translated(delta, { twist = true, smooth = true } = {}) {
    const values = new Float32Array(this.values.length);
    const radians = twist ? this.angles.radians(delta) : 0;
    for (let hop = 0; hop < PathEmbedding.HOP_BINS - 1; hop += 1) {
      const profile = this.profile(hop);
      const mass = profile.reduce((total, value) => total + value, 0);
      if (mass <= 1e-10) continue;
      const rotated = twist
        ? (smooth ? this.angles.smooth(this.angles.rotate(profile, radians)) : this.angles.rotate(profile, radians))
        : profile.slice();
      values.set(rotated, (hop + 1) * PathEmbedding.ANGLE_BINS);
    }
    values[0] = 1;
    for (let index = 0; index < values.length; index += 1) {
      if (Math.abs(values[index]) < 1e-8) values[index] = 0;
    }
    return new PathEmbedding(values);
  }

  toArray() {
    return Array.from(this.values);
  }

  static fromArray(values) {
    return new PathEmbedding(Float32Array.from(values));
  }

  static renormalize(source, target) {
    const oldMass = source.reduce((total, value) => total + value, 0);
    const newMass = target.reduce((total, value) => total + value, 0);
    if (oldMass <= 1e-12 || newMass <= 1e-12) return target;
    const scale = oldMass / newMass;
    return Float32Array.from(target, (value) => Math.max(0, value * scale));
  }

  #estimatedDepth() {
    for (let hop = PathEmbedding.HOP_BINS - 1; hop >= 1; hop -= 1) {
      let mass = 0;
      for (let angle = 0; angle < PathEmbedding.ANGLE_BINS; angle += 1) {
        mass += Math.abs(this.at(angle, hop));
      }
      if (mass > 1e-10) return hop + 1;
    }
    return 1;
  }
}
