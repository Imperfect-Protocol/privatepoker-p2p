import { Address } from '../core/Address.js';
import { Duration } from '../core/Duration.js';
import { VirtualNetworkEvent } from '../events/VirtualNetworkEvent.js';
import { ConnectionState } from '../state/ConnectionState.js';
import { ConnectionAttemptStateMachine } from '../state/ConnectionAttemptStateMachine.js';
import { ConnectionStep } from '../events/ConnectionStep.js';

export class VirtualSubscription {
  constructor(fields) {
    this.network = fields.network;
    this.subscriptionLabel = fields.subscriptionLabel;
    this.channelLabel = fields.channelLabel;
    this.peerAddress = Address.from(fields.peerAddress);
    this.timeout = Duration.fromMilliseconds(fields.timeout);
    this.lobbyId = String(fields.lobbyId ?? fields.network.config.lobbyId);
    this.tableId = String(fields.tableId ?? fields.network.config.tableId);
    this.state = ConnectionState.INITIAL;
    this.timedOutOnce = false;
    this.peerSession = null;
    this.stateMachine = new ConnectionAttemptStateMachine(this, fields.network.runtime);
  }

  canBeginNegotiation() {
    return !this.peerSession && this.state !== ConnectionState.PEER_CONNECTED;
  }

  shouldTryMeshNodeFirst() {
    return this.timedOutOnce || this.network.shouldUseMeshFirst(this.peerAddress) || !this.network.hasConnectedPeers();
  }

  rememberTimeout(timedOutState = this.state) {
    this.timedOutOnce = true;
    if (timedOutState === ConnectionState.TRY_P2P_NETWORK) {
      this.network.rememberP2PTimeout(this.peerAddress);
    }
  }

  async start() {
    this.stateMachine.start();
    if (this.state === ConnectionState.TRY_P2P_NETWORK) {
      this.network.emitConnectionStep({
        step: ConnectionStep.ATTEMPT_STARTED,
        state: this.state,
        via: 'p2p',
        subscriptionLabel: this.subscriptionLabel,
        channelLabel: this.channelLabel,
        lobbyId: this.lobbyId,
        tableId: this.tableId,
        peerAddress: this.peerAddress.toString(),
      });
      await this.network.p2pNetwork.findPeer(this);
      return;
    }
    this.network.emitConnectionStep({
      step: ConnectionStep.ATTEMPT_STARTED,
      state: this.state,
      via: 'mesh',
      subscriptionLabel: this.subscriptionLabel,
      channelLabel: this.channelLabel,
      lobbyId: this.lobbyId,
      tableId: this.tableId,
      peerAddress: this.peerAddress.toString(),
    });
    await this.network.meshNetwork.findPeer(this);
  }

  attachPeerSession(peerSession) {
    this.peerSession = peerSession;
    this.peerSession.onConnected = () => this.handleConnected();
    this.peerSession.onDisconnected = () => this.handleDisconnected();
    this.peerSession.onMessage = (message) => this.handleMessage(message);
  }

  handleConnected() {
    this.stateMachine.connected();
    this.network.registerConnectedSubscription(this);
    this.network.handler(VirtualNetworkEvent.peerConnected({
      state: ConnectionState.PEER_CONNECTED,
      subscriptionLabel: this.subscriptionLabel,
      channelLabel: this.channelLabel,
      lobbyId: this.lobbyId,
      tableId: this.tableId,
      peerAddress: this.peerAddress.toString(),
    }));
  }

  handleDisconnected() {
    this.stateMachine.disconnected();
    this.network.handler(VirtualNetworkEvent.peerDisconnected({
      state: ConnectionState.DISCONNECTED,
      subscriptionLabel: this.subscriptionLabel,
      channelLabel: this.channelLabel,
      lobbyId: this.lobbyId,
      tableId: this.tableId,
      peerAddress: this.peerAddress.toString(),
    }));
  }

  handleMessage(message) {
    this.network.handler(VirtualNetworkEvent.messageReceived({
      subscriptionLabel: this.subscriptionLabel,
      lobbyId: this.lobbyId,
      tableId: this.tableId,
      messageData: message.messageData,
      peerAddress: this.peerAddress.toString(),
    }));
  }

  emitTimeout(timedOutState = this.state) {
    this.network.handler(VirtualNetworkEvent.connectionTimeout({
      state: ConnectionState.CONNECTION_TIMEOUT,
      subscriptionLabel: this.subscriptionLabel,
      channelLabel: this.channelLabel,
      lobbyId: this.lobbyId,
      tableId: this.tableId,
      peerAddress: this.peerAddress.toString(),
    }));
    if (timedOutState === ConnectionState.TRY_MESH_NODE) {
      this.network.meshNetwork.reportFailed(this, 'timeout');
    }
  }

  emitFailure(error) {
    this.network.handler(VirtualNetworkEvent.connectionFailed({
      state: ConnectionState.FAILED,
      subscriptionLabel: this.subscriptionLabel,
      channelLabel: this.channelLabel,
      lobbyId: this.lobbyId,
      tableId: this.tableId,
      peerAddress: this.peerAddress.toString(),
      error,
      errorMessage: error?.message ?? String(error),
    }));
  }

  stop() {
    this.stateMachine.disconnected();
    this.abortNegotiation();
  }

  abortNegotiation() {
    this.peerSession?.close();
    this.peerSession = null;
  }
}
