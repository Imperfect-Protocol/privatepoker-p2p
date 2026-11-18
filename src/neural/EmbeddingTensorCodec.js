import { Result } from '../core/Result.js';
import { Tensor } from './Tensor.js';
import { TensorShape } from './TensorShape.js';
import { PathEmbedding } from './PathEmbedding.js';

/**
 * Packs a bundle of per-signal 8x8 embeddings into one padded tensor, applies
 * the wavelet/noise/threshold pipeline, then sparse+DEFLATE encodes it.
 *
 * The receiver inverts the Haar transform and re-applies the exact occupied-layer
 * mask from lossless metadata, so codec noise can never invent path history in a
 * layer that the sender never occupied.
 */
export class EmbeddingTensorCodec {
  constructor(fields) {
    this.pipeline = fields.pipeline;
    this.sparseCodec = fields.sparseCodec;
    this.trace = fields.trace;
  }

  async encode(signals) {
    if (signals.length === 0) throw new Error('cannot encode an empty neural bundle');
    const paddedCount = EmbeddingTensorCodec.paddedCount(signals.length);
    const shape = [paddedCount, PathEmbedding.ANGLE_BINS, PathEmbedding.HOP_BINS];
    const tensor = Tensor.zeros(shape);
    signals.forEach((signal, index) => {
      const normalized = signal.embedding.normalized(signal.embeddingDepth);
      const offset = index * PathEmbedding.ANGLE_BINS * PathEmbedding.HOP_BINS;
      tensor.data.set(normalized.values, offset);
    });
    for (let index = signals.length; index < paddedCount; index += 1) {
      const offset = index * PathEmbedding.ANGLE_BINS * PathEmbedding.HOP_BINS;
      tensor.data.fill(0, offset, offset + PathEmbedding.ANGLE_BINS * PathEmbedding.HOP_BINS);
    }

    const coefficients = this.pipeline.coefficients(tensor);
    const encoded = await this.sparseCodec.encode(coefficients);
    if (!encoded.ok) return encoded;
    this.trace?.debug('codec.encoded', {
      signals: signals.length,
      paddedCount,
      rawValues: tensor.size,
      coefficientCount: encoded.value.coefficientCount,
      codec: encoded.value.codec,
    });
    return Result.ok({
      shape,
      payload: encoded.value.payload,
      codec: encoded.value.codec,
      coefficientCount: encoded.value.coefficientCount,
      rawValues: tensor.size,
    });
  }

  async decode(tensorFields, signals) {
    const shape = new TensorShape(tensorFields.shape);
    if (shape.rank !== 3 || shape.dimensions[1] !== PathEmbedding.ANGLE_BINS
      || shape.dimensions[2] !== PathEmbedding.HOP_BINS) {
      return Result.err(new Error(`invalid neural tensor shape ${tensorFields.shape}`));
    }
    if (shape.dimensions[0] < signals.length) {
      return Result.err(new Error('neural tensor has fewer rows than signals'));
    }
    const coefficients = await this.sparseCodec.decode(tensorFields.payload, shape.dimensions);
    if (!coefficients.ok) return coefficients;
    const reconstructed = this.pipeline.reconstruct(coefficients.value);
    this.trace?.debug('codec.decoded', {
      signals: signals.length,
      paddedCount: shape.dimensions[0],
      coefficientCount: tensorFields.coefficientCount,
      codec: tensorFields.codec,
    });
    return Result.ok(signals.map((signal, index) => {
      const start = index * PathEmbedding.ANGLE_BINS * PathEmbedding.HOP_BINS;
      const values = Float32Array.from(
        reconstructed.data.subarray(start, start + PathEmbedding.ANGLE_BINS * PathEmbedding.HOP_BINS),
        (value) => Math.max(0, value),
      );
      return new PathEmbedding(values).normalized(signal.embeddingDepth);
    }));
  }

  static paddedCount(count) {
    let size = 1;
    while (size < count) size *= 2;
    return size;
  }
}
