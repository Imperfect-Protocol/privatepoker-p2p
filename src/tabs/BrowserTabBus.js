import { VirtualNetworkConsoleLogger } from '../logging/VirtualNetworkConsoleLogger.js';

/**
 * Broadcast-channel-only message transport between tabs.
 *
 * The channel carries value objects. It owns no protocol state and survives no
 * page reload; every tab keeps its own state in memory.
 */
export class BrowserTabBus {
  constructor(host) {
    this.host = host;
    this.channel = null;
    this.sessions = new Map();
    this.open();
  }

  debug(label, detail = {}) {
    VirtualNetworkConsoleLogger.log(`tab-bus.${label}`, {
      ...detail,
      address: this.host.address.toString(),
      instanceId: this.host.instanceId,
      role: this.host.config.role,
      peerId: this.host.config.peerId,
    });
  }

  open() {
    if (!this.host.runtime.BroadcastChannel) return;
    this.channel = new this.host.runtime.BroadcastChannel(`${this.host.config.broadcastPrefix}:${this.host.config.peerId}:control`);
    this.channel.onmessage = (event) => this.host.handleControlMessage(event.data, 'local');
    this.debug('broadcast.ready');
  }

  register(subscription) {
    const session = {
      address: this.host.address.toString(),
      instanceId: this.host.instanceId,
      role: this.host.config.role,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
    };
    this.sessions.set(subscription.subscriptionLabel, session);
    this.debug('session.register', { session });
  }

  unregister(subscription) {
    const session = this.sessions.get(subscription.subscriptionLabel);
    this.sessions.delete(subscription.subscriptionLabel);
    this.debug('session.unregister', { session });
  }

  findTableSession(fields = {}) {
    for (const session of this.sessions.values()) {
      if (session.role !== 'table') continue;
      if (fields.subscriptionLabel && session.subscriptionLabel !== fields.subscriptionLabel) continue;
      if (fields.channelLabel && session.channelLabel !== fields.channelLabel) continue;
      if (fields.lobbyId && session.lobbyId !== String(fields.lobbyId)) continue;
      if (fields.tableId && session.tableId !== String(fields.tableId)) continue;
      return session;
    }
    return null;
  }

  post(message) {
    this.debug('post', {
      messageType: message.type,
      from: message.from,
      to: message.to,
      targetRole: message.targetRole,
      tableId: message.tableId,
    });
    this.channel?.postMessage(message);
  }

  close() {
    this.channel?.close();
    this.sessions.clear();
    this.channel = null;
  }
}
