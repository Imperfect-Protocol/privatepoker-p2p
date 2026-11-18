import { Tensor, forEachAxisLine } from './Tensor.js';

/**
 * A normalized one-dimensional Gaussian kernel.
 *
 * SciPy's default `truncate=4.0` gives `radius = round(4 * sigma)` and a
 * symmetric kernel. The same kernel is used on every tensor axis.
 */
export class GaussianKernel {
  constructor(sigma) {
    this.sigma = Number(sigma);
    this.radius = Math.round(4 * this.sigma);
    this.weights = this.#weights();
  }

  static forSigma(sigma) {
    const value = Number(sigma);
    if (!Number.isFinite(value) || value <= 0) return null;
    const kernel = new GaussianKernel(value);
    return kernel.radius < 1 ? null : kernel;
  }

  #weights() {
    const taps = Array.from({ length: 2 * this.radius + 1 }, (_, index) => index - this.radius);
    const weights = taps.map((tap) => Math.exp(-0.5 * (tap / this.sigma) ** 2));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    return Float64Array.from(weights, (weight) => weight / total);
  }
}

/**
 * Separable Gaussian smoothing with SciPy's `mode="nearest"` boundary rule:
 * indices outside the axis are clamped to the nearest valid index.
 */
export class GaussianFilter {
  constructor(sigma) {
    this.kernel = GaussianKernel.forSigma(sigma);
  }

  apply(tensor) {
    if (!this.kernel) return tensor;
    return Array.from({ length: tensor.rank }, (_, axis) => axis).reduce(
      (result, axis) => this.applyAxis(result, axis),
      tensor,
    );
  }

  applyAxis(tensor, axis) {
    if (!this.kernel) return tensor;
    const output = Tensor.zeros(tensor.shape.dimensions);
    const length = tensor.shape.axisLength(axis);
    const stride = tensor.shape.axisStride(axis);
    const { radius, weights } = this.kernel;
    forEachAxisLine(tensor.shape, axis, (base) => {
      for (let index = 0; index < length; index += 1) {
        let value = 0;
        for (let tap = -radius; tap <= radius; tap += 1) {
          const clamped = Math.min(length - 1, Math.max(0, index + tap));
          value += tensor.data[base + clamped * stride] * weights[tap + radius];
        }
        output.data[base + index * stride] = value;
      }
    });
    return output;
  }
}
