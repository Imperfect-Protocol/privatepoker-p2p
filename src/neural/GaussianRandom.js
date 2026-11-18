/**
 * Deterministic Gaussian dice.
 *
 * The state transition is NumPy's PCG64 XSL-RR generator, enough for repeatable
 * JS tests and for deterministic replay alongside the Python simulator. Noise is
 * tiny (1e-5 by default), so this is about debugging, not cryptographic quality.
 */
const MULTIPLIER = 0x2360ed051fc65da44385df649fccf645n;
const MOD_128 = 1n << 128n;
const MASK_64 = (1n << 64n) - 1n;
const TWO_53 = 9007199254740992;

export class GaussianRandom {
  constructor(state = null, increment = null) {
    this.state = state ?? GaussianRandom.#seedState();
    this.increment = increment ?? GaussianRandom.#seedIncrement();
    this.spareNormal = null;
  }

  static fromSeed(seed) {
    const value = BigInt(Math.trunc(seed) >>> 0);
    return new GaussianRandom(
      (value << 64n) | (value * 6364136223846793005n & MASK_64),
      ((value << 1n) | 1n) & MASK_64,
    );
  }

  uniform() {
    return Number(this.#nextUint64() >> 11n) * (1 / TWO_53);
  }

  normal() {
    if (this.spareNormal !== null) {
      const value = this.spareNormal;
      this.spareNormal = null;
      return value;
    }
    const first = Math.max(1e-12, this.uniform());
    const second = this.uniform();
    const radius = Math.sqrt(-2 * Math.log(first));
    this.spareNormal = radius * Math.sin(2 * Math.PI * second);
    return radius * Math.cos(2 * Math.PI * second);
  }

  #nextUint64() {
    this.state = (MULTIPLIER * this.state + this.increment) % MOD_128;
    const high = this.state >> 64n;
    const low = this.state & MASK_64;
    const rotation = Number(this.state >> 122n) & 63;
    let value = (high ^ low) & MASK_64;
    if (rotation !== 0) {
      value = ((value >> BigInt(rotation)) | (value << BigInt(64 - rotation))) & MASK_64;
    }
    return value;
  }

  static #seedState() {
    const words = globalThis.crypto?.getRandomValues?.(new Uint32Array(4))
      ?? Uint32Array.from({ length: 4 }, () => Math.floor(Math.random() * 0xffffffff));
    return words.reduce((state, word) => (state << 32n) | BigInt(word), 0n) % MOD_128;
  }

  static #seedIncrement() {
    const words = globalThis.crypto?.getRandomValues?.(new Uint32Array(2))
      ?? Uint32Array.from({ length: 2 }, () => Math.floor(Math.random() * 0xffffffff));
    return (((BigInt(words[0]) << 32n) | BigInt(words[1])) << 1n | 1n) % MOD_128;
  }
}
