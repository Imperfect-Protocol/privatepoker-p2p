import { Address } from '../core/Address.js';
import { Duration } from '../core/Duration.js';
import { VirtualNetworkEvent } from '../events/VirtualNetworkEvent.js';
import { ConnectionState } from '../state/ConnectionState.js';
import { ConnectionAttemptStateMachine } from '../state/ConnectionAttemptStateMachine.js';
import { ConnectionStep } from '../events/ConnectionStep.js';
import { SubscriptionScope } from './SubscriptionScope.js';

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

  scope() {
    return SubscriptionScope.from({
      subscriptionLabel: this.subscriptionLabel,
      channelLabel: this.channelLabel,
      peerAddress: this.peerAddress,
      lobbyId: this.lobbyId,
      tableId: this.tableId,
    });
  }

  matches(fields) {
    return SubscriptionScope.from(fields).matches(this);
  }

  canRestart() {
    return (
      !this.peerSession
      && [
        ConnectionState.INITIAL,
        ConnectionState.CONNECTION_TIMEOUT,
        ConnectionState.FAILED,
        ConnectionState.DISCONNECTED,
      ].includes(this.state)
    );
  }

  hasP2PRoute() {
    return this.network.hasConnectedPeers(this.peerAddress, this.lobbyId, this.tableId);
  }

  shouldTryMeshNodeFirst() {
    if (this.hasP2PRoute()) return false;
    return true;
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
    this.peerSession.onConnected = () => this.handleConnected(peerSession);
    this.peerSession.onDisconnected = () => this.handleDisconnected(peerSession);
    this.peerSession.onMessage = (message) => this.handleMessage(peerSession, message);
  }

  handleConnected(peerSession) {
    if (!this.isCurrentPeerSession(peerSession)) return;
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

  handleDisconnected(peerSession) {
    if (!this.isCurrentPeerSession(peerSession)) return;
    this.peerSession = null;
    this.stateMachine.disconnected();
    this.network.unregisterConnectedSubscription(this);
    this.network.handler(VirtualNetworkEvent.peerDisconnected({
      state: ConnectionState.DISCONNECTED,
      subscriptionLabel: this.subscriptionLabel,
      channelLabel: this.channelLabel,
      lobbyId: this.lobbyId,
      tableId: this.tableId,
      peerAddress: this.peerAddress.toString(),
    }));
  }

  handlePeerWaiting(message) {
    this.stateMachine.peerWaiting();
    this.network.handler(VirtualNetworkEvent.peerWaiting({
      state: ConnectionState.PEER_WAITING,
      subscriptionLabel: this.subscriptionLabel,
      channelLabel: this.channelLabel,
      lobbyId: this.lobbyId,
      tableId: this.tableId,
      peerAddress: this.peerAddress.toString(),
      waitingReason: message.waitingReason,
    }));
  }

  handleMessage(peerSession, message) {
    if (!this.isCurrentPeerSession(peerSession)) return;
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
    this.network.unregisterConnectedSubscription(this);
    this.abortNegotiation();
  }

  replaceForOffer(via) {
    this.network.unregisterConnectedSubscription(this);
    this.abortNegotiation();
    this.stateMachine.clearTimer();
    this.stateMachine.transition(via === 'p2p'
      ? ConnectionState.TRY_P2P_NETWORK
      : ConnectionState.TRY_MESH_NODE);
    this.stateMachine.armTimeout();
  }

  restart() {
    if (!this.canRestart()) return;
    this.start().catch((error) => this.stateMachine.failed(error));
  }

  isCurrentPeerSession(peerSession) {
    return this.peerSession === peerSession;
  }

  abortNegotiation() {
    const peerSession = this.peerSession;
    this.peerSession = null;
    peerSession?.close();
  }
}
