import { Tensor, forEachAxisLine } from './Tensor.js';

const INVERSE_SQRT_TWO = 1 / Math.sqrt(2);

/**
 * One-level orthonormal Haar transform, applied independently on every axis.
 *
 * Layout matches the simulator (`haar_forward_axis` / `haar_inverse_axis`):
 * the first half of an axis holds the approximation, the second half the detail.
 * Applying it on every axis is the separable N-D transform; the inverse applies
 * the same axes in reverse.
 */
export class HaarTransform {
  forward(tensor) {
    this.#requirePowerOfTwo(tensor);
    return this.#axes(tensor).reduce(
      (result, axis) => this.forwardAxis(result, axis),
      tensor,
    );
  }

  inverse(tensor) {
    this.#requirePowerOfTwo(tensor);
    return this.#axes(tensor).reverse().reduce(
      (result, axis) => this.inverseAxis(result, axis),
      tensor,
    );
  }

  forwardAxis(tensor, axis) {
    const output = Tensor.zeros(tensor.shape.dimensions);
    const length = tensor.shape.axisLength(axis);
    if (length === 1) return tensor.clone();
    const half = length / 2;
    const stride = tensor.shape.axisStride(axis);
    forEachAxisLine(tensor.shape, axis, (base) => {
      for (let index = 0; index < half; index += 1) {
        const low = tensor.data[base + index * stride];
        const high = tensor.data[base + (index + half) * stride];
        output.data[base + index * stride] = (low + high) * INVERSE_SQRT_TWO;
        output.data[base + (index + half) * stride] = (low - high) * INVERSE_SQRT_TWO;
      }
    });
    return output;
  }

  inverseAxis(tensor, axis) {
    const output = Tensor.zeros(tensor.shape.dimensions);
    const length = tensor.shape.axisLength(axis);
    if (length === 1) return tensor.clone();
    const half = length / 2;
    const stride = tensor.shape.axisStride(axis);
    forEachAxisLine(tensor.shape, axis, (base) => {
      for (let index = 0; index < half; index += 1) {
        const low = tensor.data[base + index * stride];
        const high = tensor.data[base + (index + half) * stride];
        output.data[base + index * stride] = (low + high) * INVERSE_SQRT_TWO;
        output.data[base + (index + half) * stride] = (low - high) * INVERSE_SQRT_TWO;
      }
    });
    return output;
  }

  #axes(tensor) {
    return Array.from({ length: tensor.rank }, (_, axis) => axis);
  }

  #requirePowerOfTwo(tensor) {
    tensor.shape.dimensions.forEach((dimension) => {
      if ((dimension & (dimension - 1)) !== 0) {
        throw new Error(`Haar axis lengths must be powers of two; got ${dimension}`);
      }
    });
  }
}
