import { VirtualNetworkConsoleLogger } from '../logging/VirtualNetworkConsoleLogger.js';

export class RouteBus {
  constructor(fields = {}) {
    this.channelName = fields.channelName ?? 'privatepoker-p2p:routes';
    this.logger = fields.logger ?? VirtualNetworkConsoleLogger;
    this.channel = RouteBus.createChannel(this.channelName);
  }

  static createChannel(channelName) {
    if (!globalThis.BroadcastChannel) return null;
    return new globalThis.BroadcastChannel(channelName);
  }

  publish(type, fields = {}) {
    const message = {
      ...fields,
      type,
      sentAt: Date.now(),
    };
    this.logger.log('route-bus.publish', message);
    this.channel?.postMessage(message);
    return message;
  }

  publishKeepRoute(fields = {}) {
    return this.publish('keep-route', fields);
  }

  listen(callback) {
    if (!this.channel) return;
    this.channel.onmessage = (event) => {
      this.logger.log('route-bus.recv', event.data);
      callback(event.data);
    };
  }

  close() {
    this.channel?.close();
  }
}
