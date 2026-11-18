/**
 * Shape and stride arithmetic for dense row-major tensors.
 *
 * Keeping this separate from Tensor means every algorithm can ask the same
 * object how to walk an axis, and no algorithm has to re-derive strides.
 */
export class TensorShape {
  constructor(dimensions) {
    if (!Array.isArray(dimensions) || dimensions.length === 0) {
      throw new Error('TensorShape requires at least one dimension');
    }
    this.dimensions = Object.freeze(dimensions.map((dimension) => {
      const value = Number(dimension);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`TensorShape dimensions must be positive integers; got ${dimension}`);
      }
      return value;
    }));
    this.rank = this.dimensions.length;
    this.strides = Object.freeze(this.#strides());
    this.size = this.dimensions.reduce((total, dimension) => total * dimension, 1);
  }

  static of(...dimensions) {
    return new TensorShape(dimensions);
  }

  #strides() {
    const strides = new Array(this.dimensions.length);
    let stride = 1;
    for (let axis = this.dimensions.length - 1; axis >= 0; axis -= 1) {
      strides[axis] = stride;
      stride *= this.dimensions[axis];
    }
    return strides;
  }

  axisLength(axis) {
    return this.dimensions[this.resolveAxis(axis)];
  }

  axisStride(axis) {
    return this.strides[this.resolveAxis(axis)];
  }

  resolveAxis(axis) {
    return this.#axis(axis);
  }

  offset(coordinates) {
    if (!Array.isArray(coordinates) || coordinates.length !== this.rank) {
      throw new Error(`Expected ${this.rank} coordinates`);
    }
    return coordinates.reduce((offset, coordinate, axis) => {
      const value = Number(coordinate);
      if (!Number.isInteger(value) || value < 0 || value >= this.dimensions[axis]) {
        throw new Error(`Coordinate ${axis}=${coordinate} is outside ${this.dimensions[axis]}`);
      }
      return offset + value * this.strides[axis];
    }, 0);
  }

  coordinates(offset) {
    if (!Number.isInteger(offset) || offset < 0 || offset >= this.size) {
      throw new Error(`Offset ${offset} is outside tensor size ${this.size}`);
    }
    let rest = offset;
    return this.dimensions.map((dimension, axis) => {
      const coordinate = Math.floor(rest / this.strides[axis]);
      rest -= coordinate * this.strides[axis];
      return coordinate;
    });
  }

  #axis(axis) {
    const value = Number(axis);
    if (!Number.isInteger(value) || value < 0 || value >= this.rank) {
      throw new Error(`Axis ${axis} is outside rank ${this.rank}`);
    }
    return value;
  }
}
