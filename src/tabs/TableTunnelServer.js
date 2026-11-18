import { VirtualNetworkEvent } from '../events/VirtualNetworkEvent.js';

/**
 * Lobby-owned delivery of table signalling and its endpoint lifecycle.
 *
 * A table announce is acknowledged over BroadcastChannel by the matching local
 * table tab. If no answer arrives, the remote table is offered the courtesy
 * wait flow. All bookkeeping is transient and belongs to this Lobby tab.
 */
export class TableTunnelServer {
  constructor(network, delayMs) {
    this.network = network;
    this.delayMs = delayMs;
    this.pending = new Map();
    this.waiting = new Map();
  }

  static scope(fields) {
    return `${String(fields.peerAddress ?? fields.from).toLowerCase()}:${String(fields.lobbyId)}:${String(fields.tableId)}`;
  }

  deliver(message) {
    this.network.emitReceivedSignal(message);
    this.network.sendControlLocally(message);
    if (message.type !== 'p2p-mst-announce') return;
    this.pending.delete(message.id);
    const timer = this.network.runtime.setTimer(() => {
      this.pending.delete(message.id);
      this.network.respondPeerWaitingWhenLobbyRouteFound(message);
      this.waiting.set(TableTunnelServer.scope(message), message);
    }, this.delayMs);
    this.pending.set(message.id, timer);
  }

  acknowledge(message) {
    const timer = this.pending.get(message.requestId);
    if (timer === undefined) return;
    this.network.runtime.clearTimer(timer);
    this.pending.delete(message.requestId);
  }

  connected(message) {
    const request = this.waiting.get(TableTunnelServer.scope(message));
    if (!request) return;
    this.waiting.delete(TableTunnelServer.scope(message));
    this.network.handler(VirtualNetworkEvent.peerWaitAccepted({
      requestId: request.id,
      from: request.from,
      peerAddress: request.from,
      requesterRole: request.senderRole,
      requesterInstanceId: request.initiatorInstanceId,
      subscriptionLabel: request.subscriptionLabel,
      channelLabel: request.channelLabel,
      lobbyId: request.lobbyId,
      tableId: request.tableId,
      decisionReason: 'table-connected',
    }));
  }

  close() {
    this.pending.forEach((timer) => this.network.runtime.clearTimer(timer));
    this.pending.clear();
    this.waiting.clear();
  }
}
