import { TensorShape } from './TensorShape.js';

/**
 * A dense float32 tensor. Operations are pure: every transform returns a new
 * tensor, so a coefficient tensor can be shared without defensive copying.
 */
export class Tensor {
  constructor(shape, data = null) {
    this.shape = shape instanceof TensorShape ? shape : new TensorShape(shape);
    this.data = data ?? new Float32Array(this.shape.size);
    if (this.data.length !== this.shape.size) {
      throw new Error(`Tensor data has ${this.data.length} values; expected ${this.shape.size}`);
    }
  }

  static zeros(shape) {
    return new Tensor(shape);
  }

  static filled(shape, value) {
    const tensor = new Tensor(shape);
    tensor.data.fill(value);
    return tensor;
  }

  static fromArray(shape, values) {
    return new Tensor(shape, Float32Array.from(values));
  }

  get rank() {
    return this.shape.rank;
  }

  get size() {
    return this.shape.size;
  }

  at(...coordinates) {
    return this.data[this.shape.offset(coordinates)];
  }

  withAt(coordinates, value) {
    const tensor = this.clone();
    tensor.data[tensor.shape.offset(coordinates)] = value;
    return tensor;
  }

  clone() {
    return new Tensor(this.shape.dimensions, this.data.slice());
  }

  map(visitor) {
    const result = new Float32Array(this.size);
    for (let offset = 0; offset < this.size; offset += 1) {
      result[offset] = visitor(this.data[offset], this.shape.coordinates(offset), offset);
    }
    return new Tensor(this.shape.dimensions, result);
  }

  /** Value/offset map for passes that do not need coordinates (threshold, noise). */
  mapValues(visitor) {
    const result = new Float32Array(this.size);
    for (let offset = 0; offset < this.size; offset += 1) {
      result[offset] = visitor(this.data[offset], offset);
    }
    return new Tensor(this.shape.dimensions, result);
  }

  forEach(visitor) {
    for (let offset = 0; offset < this.size; offset += 1) {
      visitor(this.data[offset], this.shape.coordinates(offset), offset);
    }
  }

  reshape(dimensions) {
    const shape = new TensorShape(dimensions);
    if (shape.size !== this.size) {
      throw new Error(`Cannot reshape ${this.size} values into ${shape.size}`);
    }
    return new Tensor(shape.dimensions, this.data);
  }

  sum() {
    let total = 0;
    for (let offset = 0; offset < this.size; offset += 1) {
      total += this.data[offset];
    }
    return total;
  }

  max() {
    let maximum = -Infinity;
    for (let offset = 0; offset < this.size; offset += 1) {
      maximum = Math.max(maximum, this.data[offset]);
    }
    return maximum;
  }

  isFinite() {
    for (let offset = 0; offset < this.size; offset += 1) {
      if (!Number.isFinite(this.data[offset])) return false;
    }
    return true;
  }
}

/**
 * Walk every one-dimensional line parallel to `axis`. The visitor receives the
 * line's base offset, stride and length, so Haar and Gaussian code is identical
 * for any tensor rank.
 */
export function forEachAxisLine(shape, axis, visitor) {
  const resolvedAxis = shape.resolveAxis(axis);
  const lineStride = shape.strides[resolvedAxis];
  const lineLength = shape.dimensions[resolvedAxis];
  const cursor = new Array(shape.rank).fill(0);

  const walk = (dimension) => {
    if (dimension === shape.rank) {
      visitor(shape.offset(cursor), lineStride, lineLength);
      return;
    }
    if (dimension === resolvedAxis) {
      walk(dimension + 1);
      return;
    }
    for (let value = 0; value < shape.dimensions[dimension]; value += 1) {
      cursor[dimension] = value;
      walk(dimension + 1);
    }
    cursor[dimension] = 0;
  };

  walk(0);
}
