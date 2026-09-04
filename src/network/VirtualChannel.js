import { Result } from '../core/Result.js';

export class VirtualChannel {
  constructor(label, subscription, network) {
    this.label = label;
    this.subscription = subscription;
    this.network = network;
  }

  send(message) {
    if (!this.subscription.peerSession?.isConnected()) {
      return Result.err(new Error(`Channel ${this.label} is not connected.`));
    }
    this.subscription.peerSession.sendMessage(this.label, message);
    return Result.ok();
  }
}
