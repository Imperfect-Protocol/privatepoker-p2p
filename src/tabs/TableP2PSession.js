import { VirtualNetworkConfig } from '../config/VirtualNetworkConfig.js';
import { VirtualNetworkEventType } from '../events/VirtualNetworkEventType.js';
import { VirtualNetworkHost } from '../network/VirtualNetworkHost.js';
import { VirtualNetworkRuntime } from '../network/VirtualNetworkRuntime.js';
import { ConnectionDirection } from './ConnectionDirection.js';
import { PeerSessionId } from './PeerSessionId.js';

/**
 * Table-tab facade.
 *
 * A Table tab owns only its direct subscription. Peer discovery is delegated to
 * the Lobby tab through BroadcastChannel, and signalling is tunnelled through
 * the Lobby's background edge until the direct edge is open.
 */
export class TableP2PSession {
  constructor(fields = {}) {
    this.handler = fields.handler ?? (() => {});
    this.address = fields.address;
    this.privateKey = fields.privateKey;
    this.peerId = PeerSessionId.from(fields.peerId);
    this.inboundLabel = fields.inboundLabel ?? 'inbound';
    this.outboundLabel = fields.outboundLabel ?? 'outbound';
    this.direction = fields.direction ?? ConnectionDirection.ANNOUNCING;
    this.host = new VirtualNetworkHost(
      (event) => this.handleEvent(event),
      this.address,
      this.privateKey,
      new VirtualNetworkConfig({
        role: 'table',
        lobbyId: fields.lobbyId,
        tableId: fields.tableId,
        meshUrls: [],
        iceServers: fields.iceServers,
        broadcastPrefix: fields.broadcastPrefix,
        peerId: this.peerId,
      }),
      fields.runtime ?? new VirtualNetworkRuntime(),
    );
  }

  handleEvent(event) {
    if (event.type === VirtualNetworkEventType.PEER_CONNECTED) {
      this.host.broadcastControl({
        type: 'table-connection-ready',
        from: this.host.address.toString(),
        to: this.host.address.toString(),
        senderRole: this.host.config.role,
        targetRole: 'lobby',
        peerAddress: event.peerAddress,
        lobbyId: event.lobbyId,
        tableId: event.tableId,
      });
    }
    this.handler(event);
  }

  subscribe(peerAddress, lobbyId = undefined, tableId = undefined) {
    return this.host.subscribe(
      this.inboundLabel,
      this.outboundLabel,
      peerAddress,
      20_000,
      lobbyId ?? this.host.config.lobbyId,
      tableId ?? this.host.config.tableId,
    );
  }

  unsubscribe() {
    return this.host.unsubscribe(this.inboundLabel);
  }

  send(message) {
    return this.host.send(this.outboundLabel, message);
  }

  setLocalStream(stream) {
    this.host.setLocalStream(stream);
  }

  isConnected() {
    return Array.from(this.host.connectedSubscriptions.values())
      .some((subscription) => subscription.subscriptionLabel === this.inboundLabel);
  }

  close() {
    this.host.close();
  }
}
