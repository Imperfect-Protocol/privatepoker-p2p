import { Address } from '../core/Address.js';
import { Result } from '../core/Result.js';
import { P2PMessage } from '../core/P2PMessage.js';
import { VirtualNetworkConfig } from '../config/VirtualNetworkConfig.js';
import { VirtualNetworkRuntime } from './VirtualNetworkRuntime.js';
import { VirtualSubscription } from './VirtualSubscription.js';
import { VirtualChannel } from './VirtualChannel.js';
import { VirtualNetworkEvent } from '../events/VirtualNetworkEvent.js';
import { WebRtcPeerSession } from '../webrtc/WebRtcPeerSession.js';
import { NeuralRoutingNetwork } from './NeuralRoutingNetwork.js';
import { MeshNetwork } from '../mesh/MeshNetwork.js';
import { ControlMessage } from './ControlMessage.js';
import { ConnectionMemory } from './ConnectionMemory.js';
import { ConnectionStep } from '../events/ConnectionStep.js';
import { ConnectionState } from '../state/ConnectionState.js';
import { BrowserTabBus } from '../tabs/BrowserTabBus.js';
import { TableTunnelServer } from '../tabs/TableTunnelServer.js';
import { TabMessageType } from '../tabs/TabMessage.js';
import { BackgroundConnectionKeeper } from './BackgroundConnectionKeeper.js';
import { LobbyRouteClient } from './LobbyRouteClient.js';
import { SubscriptionScope } from './SubscriptionScope.js';
import { VirtualNetworkConsoleLogger } from '../logging/VirtualNetworkConsoleLogger.js';

export class VirtualNetworkHost {
  constructor(handlerFunction, address, privateKey, config = new VirtualNetworkConfig(), runtime = new VirtualNetworkRuntime()) {
    this.handler = handlerFunction;
    this.address = Address.from(address);
    this.privateKey = privateKey;
    this.config = config instanceof VirtualNetworkConfig ? config : new VirtualNetworkConfig(config);
    this.runtime = runtime;
    this.instanceId = this.runtime.crypto.randomUUID();
    this.subscriptions = new Map();
    this.channels = new Map();
    this.connectedSubscriptions = new Map();
    this.seenControlMessages = new Set();
    this.connectionMemory = new ConnectionMemory();
    this.p2pNetwork = this.config.role === 'table'
      ? new LobbyRouteClient(this)
      : new NeuralRoutingNetwork(this);
    this.p2pNetwork.start();
    this.meshNetwork = new MeshNetwork(this);
    this.controlBus = new BrowserTabBus(this);
    this.backgroundKeeper = new BackgroundConnectionKeeper(this);
    this.tableTunnel = new TableTunnelServer(this, this.config.tablePresenceTimeoutMs);
    this.localStream = null;
    this.closed = false;
  }

  subscribe(subscriptionLabel, channelLabel, peerAddress, timeout, lobbyId = undefined, tableId = undefined) {
    if (this.closed) return Result.err(new Error('Network is closed.'));
    const subscriptionFields = {
      subscriptionLabel,
      channelLabel,
      peerAddress,
      lobbyId: lobbyId ?? this.config.lobbyId,
      tableId: tableId ?? this.config.tableId,
    };
    const scope = SubscriptionScope.from(subscriptionFields);
    const existing = this.subscriptions.get(scope.subscriptionKey());
    if (existing) {
      existing.restart();
      return Result.ok();
    }

    const subscription = new VirtualSubscription({
      network: this,
      subscriptionLabel,
      channelLabel,
      peerAddress,
      timeout,
      lobbyId: subscriptionFields.lobbyId,
      tableId: subscriptionFields.tableId,
    });
    this.subscriptions.set(scope.subscriptionKey(), subscription);
    this.channels.set(scope.channelKey(), new VirtualChannel(channelLabel, subscription, this));
    this.controlBus.register(subscription);
    subscription.start().catch((error) => subscription.stateMachine.failed(error));
    return Result.ok();
  }

  unsubscribe(subscriptionLabel) {
    this.findSubscriptionsByLabel(subscriptionLabel).forEach((subscription) => {
      this.stopSubscription(subscription);
    });
    return Result.ok();
  }

  send(channelLabel, message) {
    const channel = this.findChannelByLabel(channelLabel);
    if (!channel) return Result.err(new Error(`Unknown channel ${channelLabel}.`));
    const p2pMessage = P2PMessage.from(message);
    const result = channel.send(p2pMessage.data);
    if (result.ok) {
      this.handler(VirtualNetworkEvent.messageDelivered({
        channelLabel,
        messageData: p2pMessage.data,
      }));
    }
    return result;
  }

  emitConnectionStep(fields) {
    this.noteSubscriptionProgress(fields);
    this.handler(VirtualNetworkEvent.connectionStep(fields));
  }

  /**
   * A connection attempt only times out after silence. Every signal we send or
   * receive re-arms the subscription's idle timer.
   */
  noteSubscriptionProgress(fields = {}) {
    const peerAddress = fields.peerAddress ?? fields.from;
    if (!peerAddress) return;
    const subscription = this.findSubscriptionByMessage({
      from: peerAddress,
      subscriptionLabel: fields.subscriptionLabel,
      channelLabel: fields.channelLabel,
      lobbyId: fields.lobbyId,
      tableId: fields.tableId,
    }) ?? this.findSubscriptionByPeerScope(peerAddress, fields.lobbyId, fields.tableId);
    subscription?.noteProgress();
  }

  shouldUseMeshFirst(peerAddress) {
    return this.connectionMemory.shouldUseMeshFirst(Address.from(peerAddress).toString());
  }

  rememberP2PTimeout(peerAddress) {
    this.connectionMemory.rememberP2PTimeout(Address.from(peerAddress).toString());
  }

  registerConnectedSubscription(subscription) {
    const peerAddress = subscription.peerAddress.toString();
    this.connectionMemory.rememberConnected(peerAddress);
    this.connectedSubscriptions.set(peerAddress, subscription);
    this.p2pNetwork.neighbourAdded(peerAddress);
    this.meshNetwork.reportConnected(subscription);
    if (this.config.role === 'lobby' && subscription.tableId === '0') {
      this.backgroundKeeper.answerConnected(peerAddress);
    }
  }

  unregisterConnectedSubscription(subscription) {
    const peerAddress = subscription.peerAddress.toString();
    if (this.connectedSubscriptions.get(peerAddress) !== subscription) return;
    this.connectedSubscriptions.delete(peerAddress);
    this.p2pNetwork.neighbourRemoved(peerAddress);
    if (this.config.role === 'lobby' && subscription.tableId === '0' && subscription.canRestart()) {
      void subscription.start();
    }
  }

  getConnectedPeers() {
    return Array.from(this.connectedSubscriptions.keys());
  }

  hasConnectedPeers(peerAddress = undefined, lobbyId = undefined, tableId = undefined) {
    if (this.connectedSubscriptions.size > 0) return true;
    if (!peerAddress) return false;
    return this.config.knowsRoute(
      Address.from(peerAddress).toString(),
      String(lobbyId ?? this.config.lobbyId),
      String(tableId ?? this.config.tableId),
    );
  }

  broadcastControl(fields) {
    const message = ControlMessage.create(
      fields,
      this.runtime,
      this.address.toString(),
      this.config.controlTtl,
      this.instanceId,
    );
    this.seenControlMessages.add(message.id);
    this.sendControlLocally(message);
    if (this.config.role === 'table') return;
    if (message.type === TabMessageType.FIND_PEER_RESPONSE) return;
    if (message.to && message.to !== this.address.toString()) {
      this.p2pNetwork.sendTo(message.to, message.toFields());
      return;
    }
    this.sendControlToConnectedPeers(message);
  }

  /**
   * A discovery announce: post the control locally so a sibling tab can relay it,
   * and return the same fields for this node's own addressed announce. The
   * announce (not a relay) owns retries and the mesh fallback.
   */
  publishDiscovery(fields) {
    const message = ControlMessage.create(
      fields,
      this.runtime,
      this.address.toString(),
      this.config.controlTtl,
      this.instanceId,
    );
    this.seenControlMessages.add(message.id);
    this.sendControlLocally(message);
    return message.toFields();
  }

  sendControlLocally(message) {
    this.controlBus.post(message);
  }

  /**
   * Carry a control message that a sibling tab published for a remote peer.
   *
   * Tabs of one browser share an address but own separate overlays, so a table
   * tab with no neighbours cannot reach anyone on its own. Whichever sibling
   * already has a P2P edge forwards the message; the role check keeps the
   * sender's own role from echoing it and the address check keeps a tab from
   * relaying messages that were addressed to itself.
   */
  relayLocalControl(message) {
    if (!this.connectedSubscriptions.size) return;
    if (!message.to || message.to === this.address.toString()) return;
    if (typeof message.ttl === 'number' && message.ttl <= 0) return;
    if (message.senderRole && message.senderRole === this.config.role) return;
    VirtualNetworkConsoleLogger.log('neural.relay.control', {
      address: this.address.toString(),
      peerAddress: message.to,
      messageType: message.type,
      senderRole: message.senderRole,
      role: this.config.role,
    });
    this.p2pNetwork.sendTo(message.to, { ...message });
  }

  sendControlToConnectedPeers(message) {
    if (message.ttl <= 0) return;
    this.connectedSubscriptions.forEach((subscription) => {
      if (!subscription.peerSession?.isConnected()) return;
      subscription.peerSession.sendControl(message);
      this.emitRelayedSignal(message, subscription);
    });
  }

  /** One encoded neural bundle to exactly one direct neighbour. */
  sendNeuralBundle(neighbourAddress, bundle) {
    const peerAddress = Address.from(neighbourAddress).toString();
    const subscription = this.connectedSubscriptions.get(peerAddress);
    if (!subscription?.peerSession?.isConnected()) {
      VirtualNetworkConsoleLogger.log('neural.transport.unreachable', {
        address: this.address.toString(),
        peerAddress,
        signals: bundle.signals.length,
      });
      return;
    }
    subscription.peerSession.sendControl(ControlMessage.create({
      type: 'neural-bundle',
      from: this.address.toString(),
      to: peerAddress,
      senderRole: this.config.role,
      neural: bundle,
    }, this.runtime, this.address.toString(), this.config.controlTtl, this.instanceId));
  }

  /** The overlay could not reach an active peer: reconnect it through the mesh. */
  requestMeshFallback(targetAddress) {
    const peerAddress = Address.from(targetAddress).toString();
    if (this.connectedSubscriptions.has(peerAddress)) return;
    const subscription = this.findSubscriptionByPeer(peerAddress);
    if (!subscription) return;
    if (this.config.knowsRoute(peerAddress, subscription.lobbyId, subscription.tableId)) {
      VirtualNetworkConsoleLogger.log('neural.fallback.known-route', {
        address: this.address.toString(),
        peerAddress,
        lobbyId: subscription.lobbyId,
        tableId: subscription.tableId,
      });
      return;
    }
    VirtualNetworkConsoleLogger.log('lobby.find.mesh-fallback', {
      address: this.address.toString(),
      peerAddress,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      reason: 'neural-retries-exhausted',
    });
    VirtualNetworkConsoleLogger.log('neural.fallback.request', {
      address: this.address.toString(),
      peerAddress,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
    });
    void this.meshNetwork.findPeer(subscription);
  }

  /** A decoded announce reached this node: run the addressed control message. */
  deliverNeuralControl(payload, from) {
    this.handleControlMessage(payload, 'peer', from);
  }

  handleControlMessage(message, source = 'local', immediateSender = undefined) {
    if (!message || message.senderInstanceId === this.instanceId) return;
    if (this.seenControlMessages.has(message.id)) return;
    this.seenControlMessages.add(message.id);

    if (message.type === 'neural-bundle') {
      if (source !== 'peer') return;
      const sender = Address.from(immediateSender ?? message.sender ?? message.from).toString();
      if (!this.connectedSubscriptions.has(sender)) return;
      VirtualNetworkConsoleLogger.log('neural.transport.receive', {
        address: this.address.toString(),
        sender,
        signals: message.neural?.signals?.length ?? 0,
      });
      this.p2pNetwork.receiveBundle(message.neural, sender);
      return;
    }

    if (source === 'local' && this.config.role === 'lobby') {
      if (message.type === TabMessageType.FIND_PEER_REQUEST) {
        this.backgroundKeeper.rememberRequest(message);
        return;
      }
      if (message.type === TabMessageType.FIND_PEER_RESPONSE) return;
      if (message.type === 'p2p-table-announce-received') {
        this.tableTunnel.acknowledge(message);
        return;
      }
      if (message.type === 'table-connection-ready') {
        this.tableTunnel.connected(message);
        return;
      }
      if (message.senderRole === 'table' && message.to && message.to !== this.address.toString()) {
        this.tunnelToPeer(message);
        return;
      }
    }

    if (source === 'local' && this.config.role === 'table') {
      if (!this.acceptsLocalTableMessage(message)) {
        if (message.type === 'sdp-answer') this.emitSuppressedAnswer(message, 'local-target-mismatch');
        return;
      }
      if (message.type === TabMessageType.FIND_PEER_RESPONSE) {
        this.p2pNetwork.handleFindPeerResponse(message);
        return;
      }
      if (message.type === TabMessageType.FIND_PEER_REQUEST) return;
      if (message.type === 'p2p-mst-announce') this.acknowledgeTableAnnounce(message);
    }

    if (source === 'local') this.relayLocalControl(message);

    if (source === 'peer') {
      if (this.config.role === 'lobby' && this.isTableTargeted(message)) {
        this.tableTunnel.deliver(message);
        return;
      }
      this.emitReceivedSignal(message);
      this.sendControlLocally(message);
    }

    if (message.type === 'mesh-announce') this.handleMeshAnnounce(message);
    if (message.type === 'p2p-mst-announce') this.handleP2PAnnounce(message);
    if (message.type === 'p2p-peer-waiting') this.handleP2PPeerWaiting(message);
    if (message.type === 'p2p-peer-waiting-accepted') this.handleP2PPeerWaitAccepted(message);
    if (message.type === 'p2p-peer-waiting-rejected') this.handleP2PPeerWaitRejected(message);
    if (message.type === 'sdp-offer') void this.handleSdpOffer(message);
    if (message.type === 'sdp-answer') void this.handleSdpAnswer(message);
    this.respondPeerWaitingWhenLobbyRouteFound(message);
  }

  acceptsLocalTableMessage(message) {
    if (message.to && message.to !== this.address.toString()) return false;
    if (message.targetRole && message.targetRole !== this.config.role) return false;
    if (message.targetInstanceId && message.targetInstanceId !== this.instanceId) return false;
    if (message.lobbyId && String(message.lobbyId) !== String(this.config.lobbyId)) return false;
    if (message.tableId && String(message.tableId) !== String(this.config.tableId)) return false;
    return true;
  }

  acknowledgeTableAnnounce(message) {
    this.broadcastControl({
      type: 'p2p-table-announce-received',
      requestId: message.id,
      from: this.address.toString(),
      to: this.address.toString(),
      senderRole: this.config.role,
      targetRole: 'lobby',
      subscriptionLabel: message.subscriptionLabel,
      channelLabel: message.channelLabel,
      lobbyId: message.lobbyId,
      tableId: message.tableId,
    });
  }

  isTableTargeted(message) {
    if (message.targetRole === 'table') return true;
    return message.senderRole === 'table' && [
      'p2p-mst-announce',
      'sdp-offer',
      'sdp-answer',
      'p2p-peer-waiting-accepted',
      'p2p-peer-waiting-rejected',
    ].includes(message.type);
  }

  tunnelToPeer(message) {
    VirtualNetworkConsoleLogger.log('lobby.tunnel.forward', {
      address: this.address.toString(),
      peerAddress: message.to,
      messageType: message.type,
      senderRole: message.senderRole,
      lobbyId: message.lobbyId,
      tableId: message.tableId,
    });
    // Forward the table tab's message verbatim. The originating tab's role and
    // instance id must survive the hop so the far-side Lobby can route the
    // message to the right table tab and the table can match its instance.
    this.p2pNetwork.sendTo(message.to, { ...message });
  }

  handleMeshAnnounce(message) {
    if (message.to !== this.address.toString()) return;
    this.emitConnectionStep({
      step: ConnectionStep.ANNOUNCE_RECEIVED,
      via: 'mesh',
      from: message.from,
      to: message.to,
      lobbyId: message.lobbyId,
      tableId: message.tableId,
    });
    void this.sendOffer(message.from, message.subscriptionLabel, message.channelLabel, 'mesh', message.flowId, message.lobbyId, message.tableId);
  }

  handleP2PAnnounce(message) {
    if (message.to !== this.address.toString()) return;
    if (!this.acceptsControlTarget(message)) return;
    this.emitConnectionStep({
      step: ConnectionStep.ANNOUNCE_RECEIVED,
      via: 'p2p',
      from: message.from,
      to: message.to,
      lobbyId: message.lobbyId,
      tableId: message.tableId,
    });
    if (!this.shouldCreateP2POffer(message)) {
      this.emitConnectionStep({
        step: ConnectionStep.OFFER_SUPPRESSED,
        via: 'p2p',
        reason: 'simultaneous-p2p-announce',
        from: message.from,
        to: message.to,
        lobbyId: message.lobbyId,
        tableId: message.tableId,
      });
      return;
    }
    void this.sendOffer(
      message.from,
      message.subscriptionLabel,
      message.channelLabel,
      'p2p',
      message.flowId,
      message.lobbyId,
      message.tableId,
      {
        targetRole: message.senderRole ?? message.targetRole,
        targetInstanceId: message.initiatorInstanceId,
      },
    );
  }

  handleP2PPeerWaiting(message) {
    if (message.to !== this.address.toString()) return;
    if (!this.acceptsControlTarget(message)) return;
    const subscription = this.findSubscriptionByMessage(message);
    if (!subscription) return;
    subscription.handlePeerWaiting(message);
  }

  handleP2PPeerWaitAccepted(message) {
    if (message.to !== this.address.toString()) return;
    if (!this.acceptsControlTarget(message)) return;
    const subscription = this.findSubscriptionByMessage(message);
    if (!subscription) return;
    subscription.handlePeerWaitAccepted(message);
  }

  handleP2PPeerWaitRejected(message) {
    if (message.to !== this.address.toString()) return;
    if (!this.acceptsControlTarget(message)) return;
    const subscription = this.findSubscriptionByMessage(message);
    if (!subscription) return;
    subscription.handlePeerWaitRejected(message);
  }

  respondPeerWaitingWhenLobbyRouteFound(message) {
    if (this.config.role !== 'lobby') return;
    if (message.type !== 'p2p-mst-announce') return;
    if (message.to !== this.address.toString()) return;
    if (message.targetRole === this.config.role) return;
    this.broadcastControl({
      type: 'p2p-peer-waiting',
      from: this.address.toString(),
      to: message.from,
      senderRole: this.config.role,
      targetRole: message.senderRole,
      targetInstanceId: message.initiatorInstanceId,
      subscriptionLabel: message.subscriptionLabel,
      channelLabel: message.channelLabel,
      via: 'p2p',
      flowId: message.flowId,
      lobbyId: message.lobbyId,
      tableId: message.tableId,
      waitingReason: 'destination-browser-reachable-table-endpoint-not-ready',
    });
    this.emitConnectionStep({
      step: ConnectionStep.ROUTE_AVAILABLE,
      via: 'p2p',
      flowId: message.flowId,
      from: message.from,
      to: message.to,
      targetRole: message.targetRole,
      lobbyId: message.lobbyId,
      tableId: message.tableId,
      peerAddress: message.from,
    });
    this.handler(VirtualNetworkEvent.peerWaitRequest({
      requestId: message.id,
      state: ConnectionState.PEER_WAITING,
      from: message.from,
      to: message.to,
      requesterRole: message.senderRole,
      requesterInstanceId: message.initiatorInstanceId,
      subscriptionLabel: message.subscriptionLabel,
      channelLabel: message.channelLabel,
      lobbyId: message.lobbyId,
      tableId: message.tableId,
      peerAddress: message.from,
      waitingReason: 'destination-browser-reachable-table-endpoint-not-ready',
    }));
  }

  async sendOffer(peerAddress, subscriptionLabel, channelLabel, via, flowId = '', lobbyId = undefined, tableId = undefined, control = {}) {
    const subscription = this.findOrCreateRemoteSubscription({
      from: peerAddress,
      subscriptionLabel,
      channelLabel,
      lobbyId: lobbyId ?? this.config.lobbyId,
      tableId: tableId ?? this.config.tableId,
    });
    if (!this.prepareOutgoingOffer(subscription, {
      via,
      flowId,
      subscriptionLabel,
      channelLabel,
    })) return;
    const peerSession = this.createPeerSession(peerAddress);
    this.emitConnectionStep({
      step: ConnectionStep.OFFER_CREATING,
      via,
      flowId,
      subscriptionLabel,
      channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    subscription.attachPeerSession(peerSession);
    let offer;
    try {
      offer = await peerSession.createOffer();
    } catch (error) {
      if (subscription.peerSession !== peerSession) return;
      subscription.stateMachine.failed(error);
      return;
    }
    // Inbound communication may have replaced this session while the offer was
    // being created. If so, withhold our offer and let the peer lead.
    if (subscription.peerSession !== peerSession) return;
    subscription.markOfferSent();
    this.emitConnectionStep({
      step: ConnectionStep.OFFER_SENT,
      via,
      flowId,
      subscriptionLabel,
      channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    this.broadcastControl({
      type: 'sdp-offer',
      from: this.address.toString(),
      to: Address.from(peerAddress).toString(),
      senderRole: this.config.role,
      targetRole: control.targetRole,
      targetInstanceId: control.targetInstanceId,
      responderInstanceId: this.instanceId,
      subscriptionLabel,
      channelLabel,
      via,
      flowId,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      sdp: offer.sdp,
    });
  }

  async handleSdpOffer(message) {
    if (message.to !== this.address.toString()) return;
    if (!this.acceptsControlTarget(message)) return;
    const subscription = this.findOrCreateRemoteSubscription(message);
    if (!this.prepareIncomingOffer(subscription, message)) return;
    this.emitConnectionStep({
      step: ConnectionStep.OFFER_RECEIVED,
      via: message.via,
      flowId: message.flowId,
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    const peerSession = this.createPeerSession(message.from);
    subscription.attachPeerSession(peerSession);
    this.emitConnectionStep({
      step: ConnectionStep.ANSWER_CREATING,
      via: message.via,
      flowId: message.flowId,
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    const answer = await peerSession.acceptOffer({ type: 'offer', sdp: message.sdp });
    this.emitConnectionStep({
      step: ConnectionStep.ANSWER_SENT,
      via: message.via,
      flowId: message.flowId,
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    this.broadcastControl({
      type: 'sdp-answer',
      from: this.address.toString(),
      to: message.from,
      senderRole: this.config.role,
      targetRole: message.senderRole,
      targetInstanceId: message.responderInstanceId,
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      via: message.via,
      flowId: message.flowId,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      sdp: answer.sdp,
    });
  }

  async handleSdpAnswer(message) {
    if (message.to !== this.address.toString()) {
      return this.emitSuppressedAnswer(message, 'wrong-address');
    }
    if (!this.acceptsControlTarget(message)) {
      return this.emitSuppressedAnswer(message, 'target-mismatch');
    }
    const subscription = this.findSubscriptionByMessage(message);
    if (!subscription) return this.emitSuppressedAnswer(message, 'subscription-missing');
    if (subscription.state === ConnectionState.PEER_CONNECTED) {
      return this.emitSuppressedAnswer(message, 'already-connected');
    }
    // Only an outstanding local offer can consume an answer. In a glare both
    // sides may answer each other, and the answer for a replaced offer must not
    // be applied to the surviving session.
    if (!subscription.peerSession?.hasLocalOffer?.()) {
      return this.emitSuppressedAnswer(message, 'no-local-offer');
    }
    this.emitConnectionStep({
      step: ConnectionStep.ANSWER_RECEIVED,
      via: message.via,
      flowId: message.flowId,
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    await subscription.peerSession.applyAnswer({ type: 'answer', sdp: message.sdp });
  }

  emitSuppressedAnswer(message, reason) {
    this.emitConnectionStep({
      step: ConnectionStep.ANSWER_SUPPRESSED,
      via: message.via,
      reason,
      flowId: message.flowId,
      subscriptionLabel: message.subscriptionLabel,
      channelLabel: message.channelLabel,
      lobbyId: message.lobbyId ?? this.config.lobbyId,
      tableId: message.tableId ?? this.config.tableId,
      peerAddress: message.from,
    });
  }

  async handleMeshTriggerOffer(message, enqueue) {
    const subscription = this.findMeshSubscription(message, message.target);
    if (!subscription) return;
    if (!this.prepareOutgoingOffer(subscription, {
      via: 'mesh',
      flowId: message.flowId,
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
    })) return;
    this.emitConnectionStep({
      step: ConnectionStep.ANNOUNCE_RECEIVED,
      via: 'mesh',
      flowId: message.flowId,
      lobbyId: message.lobbyId,
      tableId: message.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    this.emitConnectionStep({
      step: ConnectionStep.OFFER_REQUESTED,
      via: 'mesh',
      flowId: message.flowId,
      lobbyId: message.lobbyId,
      tableId: message.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    const peerSession = this.createPeerSession(message.target);
    subscription.attachPeerSession(peerSession);
    this.emitConnectionStep({
      step: ConnectionStep.OFFER_CREATING,
      via: 'mesh',
      flowId: message.flowId,
      lobbyId: message.lobbyId,
      tableId: message.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    const offer = await peerSession.createOffer();
    this.emitConnectionStep({
      step: ConnectionStep.OFFER_SENT,
      via: 'mesh',
      flowId: message.flowId,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    enqueue(this.meshNetwork.createInterestMessage(subscription, message.flowId, offer.sdp));
  }

  async handleMeshOffer(message, enqueue) {
    const subscription = this.findOrCreateRemoteSubscription({
      from: message.from,
      subscriptionLabel: message.subscriptionLabel,
      channelLabel: message.channelLabel,
      lobbyId: message.lobbyId,
      tableId: message.tableId,
    });
    if (!this.prepareIncomingOffer(subscription, {
      ...message,
      via: 'mesh',
    })) return;
    this.emitConnectionStep({
      step: ConnectionStep.OFFER_RECEIVED,
      via: 'mesh',
      flowId: message.flowId,
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    const peerSession = this.createPeerSession(message.from);
    subscription.attachPeerSession(peerSession);
    this.emitConnectionStep({
      step: ConnectionStep.ANSWER_CREATING,
      via: 'mesh',
      flowId: message.flowId,
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    const answer = await peerSession.acceptOffer({ type: 'offer', sdp: message.sdp });
    this.emitConnectionStep({
      step: ConnectionStep.ANSWER_SENT,
      via: 'mesh',
      flowId: message.flowId,
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    enqueue(this.meshNetwork.createAnswerMessage(subscription, message.flowId, answer.sdp));
  }

  async handleMeshAnswer(message) {
    const subscription = this.findMeshSubscription(message, message.from);
    if (!subscription) return;
    if (subscription.state === ConnectionState.PEER_CONNECTED) return;
    this.emitConnectionStep({
      step: ConnectionStep.ANSWER_RECEIVED,
      via: 'mesh',
      flowId: message.flowId,
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    await subscription.peerSession.applyAnswer({ type: 'answer', sdp: message.sdp });
  }

  handleMeshRouteAvailable(message) {
    const subscription = this.findMeshSubscription(message, message.target);
    if (!subscription) return;
    if (!subscription.canBeginNegotiation()) return;
    this.emitConnectionStep({
      step: ConnectionStep.ROUTE_AVAILABLE,
      via: 'mesh',
      flowId: message.flowId,
      lobbyId: message.lobbyId,
      tableId: message.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    void this.p2pNetwork.findPeer(subscription);
  }

  findMeshSubscription(message, peerAddress) {
    if (this.config.role === 'lobby') return this.findSubscriptionByPeer(peerAddress, undefined, '0');
    return this.findSubscriptionByPeer(peerAddress, message.lobbyId, message.tableId);
  }

  findSubscriptionByPeer(peerAddress, lobbyId = undefined, tableId = undefined) {
    const address = Address.from(peerAddress).toString();
    for (const subscription of this.subscriptions.values()) {
      if (subscription.peerAddress.toString() !== address) continue;
      if (lobbyId !== undefined && subscription.lobbyId !== String(lobbyId)) continue;
      if (tableId !== undefined && subscription.tableId !== String(tableId)) continue;
      return subscription;
    }
    return null;
  }

  findOrCreateRemoteSubscription(message) {
    const scope = SubscriptionScope.from({
      subscriptionLabel: message.subscriptionLabel,
      channelLabel: message.channelLabel,
      peerAddress: message.from,
      lobbyId: message.lobbyId ?? this.config.lobbyId,
      tableId: message.tableId ?? this.config.tableId,
    });
    const existing = this.config.role === 'lobby'
      ? this.findSubscriptionByPeer(message.from, undefined, '0')
      : this.subscriptions.get(scope.subscriptionKey());
    if (existing) return existing;

    const subscription = new VirtualSubscription({
      network: this,
      subscriptionLabel: message.subscriptionLabel,
      channelLabel: message.channelLabel,
      peerAddress: message.from,
      timeout: 45_000,
      lobbyId: message.lobbyId ?? this.config.lobbyId,
      tableId: message.tableId ?? this.config.tableId,
    });
    this.subscriptions.set(scope.subscriptionKey(), subscription);
    this.channels.set(scope.channelKey(), new VirtualChannel(message.channelLabel, subscription, this));
    this.controlBus.register(subscription);
    return subscription;
  }

  findSubscriptionByMessage(message) {
    const scope = SubscriptionScope.from({
      subscriptionLabel: message.subscriptionLabel,
      channelLabel: message.channelLabel,
      peerAddress: message.from,
      lobbyId: message.lobbyId ?? this.config.lobbyId,
      tableId: message.tableId ?? this.config.tableId,
    });
    return this.subscriptions.get(scope.subscriptionKey()) ?? null;
  }

  findSubscriptionsByLabel(subscriptionLabel) {
    return Array.from(this.subscriptions.values()).filter((subscription) => (
      subscription.subscriptionLabel === subscriptionLabel
    ));
  }

  findChannelByLabel(channelLabel) {
    for (const channel of this.channels.values()) {
      if (channel.label !== channelLabel) continue;
      if (channel.subscription.peerSession?.isConnected()) return channel;
    }
    for (const channel of this.channels.values()) {
      if (channel.label === channelLabel) return channel;
    }
    return null;
  }

  pokePeer(peerAddress, lobbyId = undefined, tableId = undefined) {
    const subscription = this.findSubscriptionByPeer(peerAddress, lobbyId, tableId);
    if (!subscription) return Result.err(new Error(`No subscription to ${peerAddress}.`));
    subscription.forceRestart();
    return Result.ok();
  }

  hasConnectedChannel(channelLabel) {
    return Array.from(this.channels.values()).some((channel) => (
      channel.label === channelLabel && channel.subscription.peerSession?.isConnected()
    ));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.handler = () => {};
    Array.from(this.subscriptions.values()).forEach((subscription) => this.stopSubscription(subscription));
    this.p2pNetwork?.stop?.();
    this.meshNetwork.close();
    this.backgroundKeeper.close();
    this.tableTunnel.close();
    this.controlBus.close();
    this.localStream = null;
  }

  stopSubscription(subscription) {
    subscription.stop();
    this.controlBus.unregister(subscription);
    this.subscriptions.delete(subscription.scope().subscriptionKey());
    this.channels.delete(subscription.scope().channelKey());
    this.connectedSubscriptions.delete(subscription.peerAddress.toString());
  }

  prepareIncomingOffer(subscription, message) {
    if (subscription.canBeginNegotiation()) return true;
    if (subscription.state === ConnectionState.PEER_CONNECTED) {
      if (subscription.tableId === '0' || message.via === 'mesh') return false;
    }
    if (subscription.state !== ConnectionState.PEER_CONNECTED && subscription.peerSession?.isConnected()) return false;

    // If an inbound offer arrives while our own offer is still being created,
    // the peer's communication wins: drop ours and answer theirs.
    const isCollidingOffer = message.via === 'p2p' && Boolean(subscription.peerSession?.hasLocalOffer?.());
    if (isCollidingOffer && subscription.localOfferSent) {
      // Both offers are already on the wire. Only the lower address keeps its
      // own offer so the two sides agree on who answers.
      if (this.address.toString() < Address.from(message.from).toString()) {
        this.emitConnectionStep({
          step: ConnectionStep.OFFER_SUPPRESSED,
          via: message.via,
          reason: 'simultaneous-p2p-offer',
          flowId: message.flowId,
          subscriptionLabel: subscription.subscriptionLabel,
          channelLabel: subscription.channelLabel,
          lobbyId: subscription.lobbyId,
          tableId: subscription.tableId,
          peerAddress: subscription.peerAddress.toString(),
        });
        return false;
      }
    }

    this.emitConnectionStep({
      step: ConnectionStep.REPLACING_CONNECTION,
      via: message.via,
      flowId: message.flowId,
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    subscription.replaceForOffer(message.via);
    return true;
  }

  prepareOutgoingOffer(subscription, message) {
    if (subscription.canBeginNegotiation()) return true;
    if (message.via !== 'p2p' || subscription.state !== ConnectionState.TRY_MESH_NODE) return false;
    this.emitConnectionStep({
      step: ConnectionStep.REPLACING_CONNECTION,
      via: message.via,
      flowId: message.flowId,
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    subscription.replaceForOffer(message.via);
    return true;
  }

  createPeerSession(peerAddress) {
    const peerSession = new WebRtcPeerSession({
      localAddress: this.address.toString(),
      peerAddress: Address.from(peerAddress).toString(),
      rtcConfig: this.config.rtcConfiguration(),
      RTCPeerConnection: this.runtime.RTCPeerConnection,
      runtime: this.runtime,
      iceGatheringTimeoutMs: this.config.iceGatheringTimeoutMs,
    });
    peerSession.onControl = (message) => this.handleControlMessage(message, 'peer');
    peerSession.onMediaStream = (stream) => this.handler(VirtualNetworkEvent.mediaStream({
      peerAddress: peerSession.peerAddress,
      stream,
    }));
    peerSession.setLocalStream(this.localStream);
    return peerSession;
  }

  setLocalStream(stream) {
    this.localStream = stream;
    this.subscriptions.forEach((subscription) => subscription.peerSession?.setLocalStream(stream));
  }

  acceptsControlTarget(message) {
    if (message.targetRole && message.targetRole !== this.config.role) return false;
    if (message.targetInstanceId && message.targetInstanceId !== this.instanceId) return false;
    return true;
  }

  emitRelayedSignal(message, subscription) {
    if (!this.isSessionDescriptionSignal(message)) return;
    this.emitConnectionStep({
      step: ConnectionStep.SIGNAL_RELAYED,
      via: 'p2p',
      direction: 'outbound',
      messageType: message.type,
      from: message.from,
      to: message.to,
      targetRole: message.targetRole,
      lobbyId: message.lobbyId,
      tableId: message.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    this.handler(VirtualNetworkEvent.messageDelivered({
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      peerAddress: subscription.peerAddress.toString(),
      messageData: message,
    }));
  }

  emitReceivedSignal(message) {
    if (!this.isSessionDescriptionSignal(message)) return;
    this.handler(VirtualNetworkEvent.messageReceived({
      subscriptionLabel: message.subscriptionLabel,
      lobbyId: message.lobbyId,
      tableId: message.tableId,
      peerAddress: message.from,
      messageData: message,
    }));
  }

  isSessionDescriptionSignal(message) {
    return message.type === 'sdp-offer' || message.type === 'sdp-answer';
  }

  findSubscriptionByPeerScope(peerAddress, lobbyId, tableId) {
    const wantedPeer = Address.from(peerAddress).toString();
    const wantedLobbyId = String(lobbyId ?? this.config.lobbyId);
    const wantedTableId = String(tableId ?? this.config.tableId);
    for (const subscription of this.subscriptions.values()) {
      if (subscription.peerAddress.toString() !== wantedPeer) continue;
      if (subscription.lobbyId !== wantedLobbyId) continue;
      if (subscription.tableId !== wantedTableId) continue;
      return subscription;
    }
    return null;
  }

  shouldCreateP2POffer(message) {
    const subscription = this.findSubscriptionByMessage(message)
      ?? this.findSubscriptionByPeerScope(message.from, message.lobbyId, message.tableId);
    if (!subscription) return true;
    if (subscription.peerAddress.toString() !== Address.from(message.from).toString()) return true;
    const negotiating = subscription.state === ConnectionState.TRY_P2P_NETWORK
      || subscription.state === ConnectionState.INITIAL;
    if (!negotiating) return true;
    return this.address.toString() < Address.from(message.from).toString();
  }
}
