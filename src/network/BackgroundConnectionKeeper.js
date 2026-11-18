import { Address } from '../core/Address.js';
import { TabMessage } from '../tabs/TabMessage.js';
import { VirtualNetworkConsoleLogger } from '../logging/VirtualNetworkConsoleLogger.js';

/**
 * Lobby-owned, in-memory record of Table tabs waiting for a peer.
 *
 * The keeper never persists a route. A route exists only while this Lobby tab
 * owns a connected background subscription, and it disappears with the tab.
 */
export class BackgroundConnectionKeeper {
  constructor(network) {
    this.network = network;
    this.requests = new Map();
  }

  static peerKey(peerAddress, lobbyId) {
    return `${Address.from(peerAddress).toString()}:${String(lobbyId ?? '1')}`;
  }

  static peerOf(key) {
    return String(key).split(':')[0];
  }

  rememberRequest(message) {
    const key = BackgroundConnectionKeeper.peerKey(message.peerAddress, message.lobbyId);
    const requests = this.requests.get(key) ?? [];
    if (!requests.some((request) => request.requestId === message.requestId)) {
      requests.push(message);
      this.requests.set(key, requests);
    }
    VirtualNetworkConsoleLogger.log('lobby.find.gossip', {
      address: this.network.address.toString(),
      requestId: message.requestId,
      peerAddress: message.peerAddress,
      lobbyId: message.lobbyId,
    });
    const subscription = this.ensureSubscription(message);
    if (subscription?.peerSession?.isConnected()) this.answerConnected(message.peerAddress);
  }

  ensureSubscription(message) {
    const peerAddress = Address.from(message.peerAddress).toString();
    const existing = this.network.findSubscriptionByPeer(peerAddress, message.lobbyId, '0');
    if (existing) return existing;
    this.network.subscribe(
      `lobby:${peerAddress}:inbound`,
      `lobby:${peerAddress}:outbound`,
      peerAddress,
      20_000,
      message.lobbyId,
      '0',
    );
    return this.network.findSubscriptionByPeer(peerAddress, message.lobbyId, '0');
  }

  answerConnected(peerAddress) {
    const wanted = Address.from(peerAddress).toString();
    Array.from(this.requests.keys()).forEach((key) => {
      if (BackgroundConnectionKeeper.peerOf(key) !== wanted) return;
      this.requests.get(key).forEach((request) => this.respond(request, 'route-ready'));
      this.requests.delete(key);
      VirtualNetworkConsoleLogger.log('lobby.find.route-ready', {
        address: this.network.address.toString(),
        peerAddress: wanted,
        lobbyId: key.slice(wanted.length + 1),
      });
    });
  }

  answerFailed(peerAddress) {
    const wanted = Address.from(peerAddress).toString();
    Array.from(this.requests.keys()).forEach((key) => {
      if (BackgroundConnectionKeeper.peerOf(key) !== wanted) return;
      this.requests.get(key).forEach((request) => this.respond(request, 'route-failed'));
      this.requests.delete(key);
      VirtualNetworkConsoleLogger.log('lobby.find.route-failed', {
        address: this.network.address.toString(),
        peerAddress: wanted,
        lobbyId: key.slice(wanted.length + 1),
      });
    });
  }

  respond(request, status) {
    this.network.broadcastControl({
      ...TabMessage.findPeerResponse({
        status,
        requestId: request.requestId,
        peerAddress: request.peerAddress,
        subscriptionLabel: request.subscriptionLabel,
        channelLabel: request.channelLabel,
        lobbyId: request.lobbyId,
        tableId: request.tableId,
      }),
      from: this.network.address.toString(),
      to: this.network.address.toString(),
      senderRole: this.network.config.role,
      targetRole: 'table',
      targetInstanceId: request.requesterInstanceId,
    });
  }

  close() {
    this.requests.clear();
  }
}
