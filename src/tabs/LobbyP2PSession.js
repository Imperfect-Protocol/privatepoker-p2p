import { VirtualNetworkConfig } from '../config/VirtualNetworkConfig.js';
import { VirtualNetworkEventType } from '../events/VirtualNetworkEventType.js';
import { VirtualNetworkHost } from '../network/VirtualNetworkHost.js';
import { VirtualNetworkRuntime } from '../network/VirtualNetworkRuntime.js';
import { PeerSessionId } from './PeerSessionId.js';

/**
 * Lobby-tab facade.
 *
 * The Lobby owns every background P2P edge and the only neural routing node.
 * Table tabs reach it through BroadcastChannel; they never own this state.
 */
export class LobbyP2PSession {
  constructor(fields = {}) {
    this.handler = fields.handler ?? (() => {});
    this.address = fields.address;
    this.privateKey = fields.privateKey;
    this.runtime = fields.runtime ?? new VirtualNetworkRuntime();
    this.peerId = fields.peerId
      ? PeerSessionId.from(fields.peerId)
      : PeerSessionId.random(this.runtime);
    this.host = new VirtualNetworkHost(
      (event) => this.handleEvent(event),
      this.address,
      this.privateKey,
      new VirtualNetworkConfig({
        role: 'lobby',
        lobbyId: fields.lobbyId,
        tableId: fields.backgroundTableId ?? '0',
        meshUrls: fields.meshUrls ?? [],
        iceServers: fields.iceServers,
        broadcastPrefix: fields.broadcastPrefix,
        peerId: this.peerId,
        neural: fields.neural ?? {},
      }),
      this.runtime,
    );
  }

  start() {}

  handleEvent(event) {
    if (event.type === VirtualNetworkEventType.PEER_WAIT_REQUEST) this.waitingRequest = event;
    if (
      event.type === VirtualNetworkEventType.PEER_WAIT_ACCEPTED
      && this.waitingRequest?.requestId === event.requestId
    ) this.waitingRequest = null;
    if (
      event.type === VirtualNetworkEventType.CONNECTION_TIMEOUT
      || event.type === VirtualNetworkEventType.CONNECTION_FAILED
    ) {
      this.host.backgroundKeeper.answerFailed(event.peerAddress);
    }
    this.handler(event);
  }

  acceptWaitingRequest(request) {
    if (!request) return;
    this.host.broadcastControl({
      type: 'p2p-peer-waiting-accepted',
      from: this.host.address.toString(),
      to: request.from,
      senderRole: 'lobby',
      targetRole: request.requesterRole,
      targetInstanceId: request.requesterInstanceId,
      subscriptionLabel: request.subscriptionLabel,
      channelLabel: request.channelLabel,
      via: 'p2p',
      flowId: request.requestId,
      lobbyId: request.lobbyId,
      tableId: request.tableId,
      decisionReason: 'accepted',
    });
    this.waitingRequest = null;
  }

  rejectWaitingRequest(request) {
    if (!request) return;
    this.host.broadcastControl({
      type: 'p2p-peer-waiting-rejected',
      from: this.host.address.toString(),
      to: request.from,
      senderRole: 'lobby',
      targetRole: request.requesterRole,
      targetInstanceId: request.requesterInstanceId,
      subscriptionLabel: request.subscriptionLabel,
      channelLabel: request.channelLabel,
      via: 'p2p',
      flowId: request.requestId,
      lobbyId: request.lobbyId,
      tableId: request.tableId,
      decisionReason: 'later',
    });
    this.waitingRequest = null;
  }

  close() {
    this.host.close();
    this.waitingRequest = null;
  }
}
