import { VirtualNetworkConsoleLogger } from '../logging/VirtualNetworkConsoleLogger.js';

/**
 * Structured debug/trace logging for the neural routing stack.
 *
 * Every stage of the pipeline (embedding twist, tensor transform, stun window,
 * routing choice, codec) logs through here so a browser console shows the whole
 * protocol trace. `trace` is for per-signal detail, `debug` for stage summaries.
 */
export class NeuralTrace {
  constructor(scope, fields = {}) {
    this.scope = scope;
    this.address = fields.address ?? null;
    this.instanceId = fields.instanceId ?? null;
    this.enabled = fields.enabled ?? true;
  }

  child(scope, fields = {}) {
    return new NeuralTrace(`${this.scope}.${scope}`, {
      address: this.address,
      instanceId: this.instanceId,
      enabled: this.enabled,
      ...fields,
    });
  }

  debug(stage, detail = {}) {
    if (!this.enabled) return;
    VirtualNetworkConsoleLogger.log(`neural.${this.scope}.${stage}`, this.#context(detail));
  }

  trace(stage, detail = {}) {
    if (!this.enabled) return;
    VirtualNetworkConsoleLogger.log(`neural.${this.scope}.${stage}`, this.#context(detail));
  }

  #context(detail) {
    return {
      ...detail,
      address: this.address,
      instanceId: this.instanceId,
    };
  }
}
