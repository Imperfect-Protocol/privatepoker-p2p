import { Address } from '../core/Address.js';
import { TabMessage } from '../tabs/TabMessage.js';
import { VirtualNetworkConsoleLogger } from '../logging/VirtualNetworkConsoleLogger.js';

/**
 * Lobby-owned, in-memory record of Table tabs waiting for a neighbour peer.
 *
 * The Lobby's background edge identity is just the peer address: the Lobby keeps
 * a `peer -> neighbour` mapping with no lobby or table identity. A pending table
 * request remembers its own (lobbyId, tableId) only so it can be answered on the
 * right table tab; once the background edge is up that pair is ignored.
 */
export class BackgroundConnectionKeeper {
  constructor(network) {
    this.network = network;
    this.requests = new Map();
  }

  rememberRequest(message) {
    const peerAddress = Address.from(message?.peerAddress ?? '').toString();
    if (peerAddress.length === 0) {
      VirtualNetworkConsoleLogger.log('lobby.find.error', {
        address: this.network.address.toString(),
        reason: 'empty-peer-address',
        requestId: message?.requestId,
        lobbyId: message?.lobbyId,
        tableId: message?.tableId,
      });
      return;
    }
    const requests = this.requests.get(peerAddress) ?? [];
    if (!requests.some((request) => request.requestId === message.requestId)) {
      requests.push(message);
      this.requests.set(peerAddress, requests);
    }
    VirtualNetworkConsoleLogger.log('lobby.find.gossip', {
      address: this.network.address.toString(),
      requestId: message.requestId,
      peerAddress,
      lobbyId: message.lobbyId,
      tableId: message.tableId,
    });
    const subscription = this.ensureSubscription(peerAddress);
    if (subscription?.peerSession?.isConnected()) this.answerConnected(peerAddress);
  }

  discoveryScope(subscription) {
    const request = this.requests.get(subscription.peerAddress.toString())?.[0];
    if (!request) return subscription;
    return {
      ...subscription,
      lobbyId: request.lobbyId,
      tableId: request.tableId,
    };
  }

  ensureSubscription(peerAddress) {
    const existing = this.network.findSubscriptionByPeer(peerAddress, undefined, '0');
    if (existing) return existing;
    this.network.subscribe(
      `lobby:${peerAddress}:inbound`,
      `lobby:${peerAddress}:outbound`,
      peerAddress,
      30_000,
      this.network.config.lobbyId,
      '0',
    );
    return this.network.findSubscriptionByPeer(peerAddress, undefined, '0');
  }

  answerConnected(peerAddress) {
    const wanted = Address.from(peerAddress).toString();
    const requests = this.requests.get(wanted);
    if (!requests) return;
    requests.forEach((request) => this.respond(request, 'route-ready'));
    this.requests.delete(wanted);
    VirtualNetworkConsoleLogger.log('lobby.find.route-ready', {
      address: this.network.address.toString(),
      peerAddress: wanted,
    });
  }

  answerFailed(peerAddress) {
    const wanted = Address.from(peerAddress).toString();
    const requests = this.requests.get(wanted);
    if (!requests) return;
    requests.forEach((request) => this.respond(request, 'route-failed'));
    this.requests.delete(wanted);
    VirtualNetworkConsoleLogger.log('lobby.find.route-failed', {
      address: this.network.address.toString(),
      peerAddress: wanted,
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