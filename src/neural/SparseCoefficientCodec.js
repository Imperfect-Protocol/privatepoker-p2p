import { Result } from '../core/Result.js';
import { Tensor } from './Tensor.js';
import { TensorShape } from './TensorShape.js';

/** Little-endian byte writer used by the sparse coefficient format. */
class ByteWriter {
  constructor(size) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
    this.cursor = 0;
  }

  uint32(value) {
    this.view.setUint32(this.cursor, value, true);
    this.cursor += 4;
  }

  float32(value) {
    this.view.setFloat32(this.cursor, value, true);
    this.cursor += 4;
  }

  finish() {
    return this.bytes;
  }
}

class ByteReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.cursor = 0;
  }

  uint32() {
    if (this.cursor + 4 > this.bytes.length) throw new Error('truncated coefficient payload');
    const value = this.view.getUint32(this.cursor, true);
    this.cursor += 4;
    return value;
  }

  float32() {
    if (this.cursor + 4 > this.bytes.length) throw new Error('truncated coefficient payload');
    const value = this.view.getFloat32(this.cursor, true);
    this.cursor += 4;
    return value;
  }

  get exhausted() {
    return this.cursor === this.bytes.length;
  }
}

export class Base64 {
  static encode(bytes) {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(bytes).toString('base64');
    }
    let binary = '';
    const chunk = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
    }
    return btoa(binary);
  }

  static decode(text) {
    if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(text, 'base64'));
    }
    const binary = atob(text);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
}

/**
 * DEFLATE (RFC 1951) through the platform's CompressionStream. If the platform
 * has no stream implementation the codec degrades to identity rather than
 * failing, so the sparse format still works.
 */
export class DeflateCodec {
  constructor(enabled = true) {
    this.requested = Boolean(enabled);
    this.available = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
  }

  get enabled() {
    return this.requested && this.available;
  }

  async compress(bytes) {
    if (!this.enabled) return Result.ok(bytes);
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
      const buffer = await new Response(stream).arrayBuffer();
      return Result.ok(new Uint8Array(buffer));
    } catch (error) {
      return Result.err(error);
    }
  }

  async decompress(bytes) {
    if (!this.enabled) return Result.ok(bytes);
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
      const buffer = await new Response(stream).arrayBuffer();
      return Result.ok(new Uint8Array(buffer));
    } catch (error) {
      return Result.err(error);
    }
  }
}

/**
 * Sparse coefficient payload: uint32 count, uint32 flat indices, float32 values,
 * then DEFLATE. The shape is protocol metadata, exactly as in the simulator, so
 * the payload never pays for the tensor's zeros.
 */
export class SparseCoefficientCodec {
  constructor(fields = {}) {
    this.deflate = new DeflateCodec(fields.compressed ?? true);
  }

  get codec() {
    return this.deflate.enabled ? 'sparse-haar+deflate' : 'sparse-haar';
  }

  async encode(tensor) {
    const indices = [];
    tensor.data.forEach((value, index) => {
      if (value !== 0) indices.push(index);
    });
    const writer = new ByteWriter(4 + indices.length * 8);
    writer.uint32(indices.length);
    indices.forEach((index) => writer.uint32(index));
    indices.forEach((index) => writer.float32(tensor.data[index]));
    const compressed = await this.deflate.compress(writer.finish());
    if (!compressed.ok) return compressed;
    return Result.ok({
      payload: Base64.encode(compressed.value),
      coefficientCount: indices.length,
      codec: this.codec,
    });
  }

  async decode(text, shapeDimensions) {
    try {
      const decompressed = await this.deflate.decompress(Base64.decode(text));
      if (!decompressed.ok) return decompressed;
      const reader = new ByteReader(decompressed.value);
      const count = reader.uint32();
      const shape = new TensorShape(shapeDimensions);
      if (count > shape.size) throw new Error('coefficient count exceeds tensor shape');
      const indices = Array.from({ length: count }, () => reader.uint32());
      const tensor = Tensor.zeros(shape.dimensions);
      indices.forEach((index) => {
        if (index >= tensor.size) throw new Error('coefficient index exceeds tensor shape');
        tensor.data[index] = reader.float32();
      });
      if (!reader.exhausted) throw new Error('coefficient payload has trailing bytes');
      return Result.ok(tensor);
    } catch (error) {
      return Result.err(error);
    }
  }
}
