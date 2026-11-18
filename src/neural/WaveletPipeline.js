import { Tensor } from './Tensor.js';
import { HaarTransform } from './HaarTransform.js';
import { GaussianFilter } from './GaussianFilter.js';
import { GaussianRandom } from './GaussianRandom.js';

/**
 * Soft thresholding: shrink every coefficient toward zero by `cutoff`.
 * Values below the numerical floor become exactly zero so sparse encoding sees
 * a genuinely sparse tensor.
 */
export class SoftThreshold {
  constructor(cutoff = 0) {
    this.cutoff = Math.max(0, Number(cutoff));
  }

  apply(tensor) {
    if (this.cutoff === 0) return tensor;
    return tensor.mapValues((value) => {
      const sign = Math.sign(value);
      const shrunken = sign * Math.max(0, Math.abs(value) - this.cutoff);
      return Math.abs(shrunken) < 1e-8 ? 0 : shrunken;
    });
  }
}

/** Gaussian background noise, one independent draw per tensor entry. */
export class NoiseInjector {
  constructor(random, strength = 0) {
    this.random = random;
    this.strength = Math.max(0, Number(strength));
  }

  apply(tensor) {
    if (this.strength <= 0) return tensor;
    return tensor.mapValues((value) => value + this.random.normal() * this.strength);
  }
}

/**
 * The simulator's complete outbound signal-processing pipeline:
 * noise -> separable Haar on every axis -> Gaussian in coefficient space ->
 * soft threshold. Reconstruction is the inverse Haar.
 *
 * When Haar is disabled the noisy tensor is sent raw, exactly like `--no-haar`:
 * noise still applies, and there is no coefficient-space blur.
 */
export class WaveletPipeline {
  constructor(fields) {
    this.noise = fields.noise;
    this.haar = fields.haar;
    this.gaussian = fields.gaussian;
    this.threshold = fields.threshold;
    this.haarEnabled = Boolean(fields.haarEnabled);
    this.gaussianEnabled = Boolean(fields.gaussianEnabled);
  }

  coefficients(tensor) {
    const noisy = this.noise.apply(tensor);
    if (!this.haarEnabled) return noisy;
    const transformed = this.haar.forward(noisy);
    const smoothed = this.gaussianEnabled ? this.gaussian.apply(transformed) : transformed;
    return this.threshold.apply(smoothed);
  }

  reconstruct(coefficients) {
    if (!this.haarEnabled) return coefficients;
    return this.haar.inverse(coefficients);
  }

  compose(tensor) {
    return this.composeWithCount(tensor).tensor;
  }

  composeWithCount(tensor) {
    const coefficients = this.coefficients(tensor);
    let coefficientCount = 0;
    for (let offset = 0; offset < coefficients.size; offset += 1) {
      if (coefficients.data[offset] !== 0) coefficientCount += 1;
    }
    return {
      tensor: this.reconstruct(coefficients),
      coefficientCount,
    };
  }

  static tensorOf(tensor) {
    if (!(tensor instanceof Tensor)) {
      throw new Error('WaveletPipeline expects a Tensor');
    }
    return tensor;
  }
}

/** Build the default pipeline from a NeuralRoutingConfig. */
export function createWaveletPipeline(config, options = {}) {
  const random = options.random ?? GaussianRandom.fromSeed(config.seed ?? (Date.now() & 0xffffffff));
  return new WaveletPipeline({
    noise: new NoiseInjector(random, config.noiseEnabled ? config.noiseStrength : 0),
    haar: new HaarTransform(),
    gaussian: new GaussianFilter(config.gaussianWidth),
    threshold: new SoftThreshold(options.threshold ?? config.messageThreshold),
    haarEnabled: config.haarEnabled,
    gaussianEnabled: config.gaussianEnabled,
  });
}
