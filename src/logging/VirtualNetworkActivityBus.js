export class VirtualNetworkActivityBus {
  constructor(fields = {}) {
    this.channelName = fields.channelName ?? 'privatepoker-p2p:debug';
    this.channel = VirtualNetworkActivityBus.createChannel(this.channelName);
  }

  static createChannel(channelName) {
    if (!globalThis.BroadcastChannel) return null;
    return new globalThis.BroadcastChannel(channelName);
  }

  publish(fields = {}) {
    const message = {
      ...fields,
      at: Date.now(),
    };
    console.debug('[privatepoker-p2p] activity', message);
    this.channel?.postMessage(message);
    return message;
  }

  listen(callback) {
    if (!this.channel) return;
    this.channel.onmessage = (event) => callback(event.data);
  }

  close() {
    this.channel?.close();
  }
}
