import { Address } from '../core/Address.js';
import { Result } from '../core/Result.js';
import { P2PMessage } from '../core/P2PMessage.js';
import { VirtualNetworkConfig } from '../config/VirtualNetworkConfig.js';
import { VirtualNetworkRuntime } from './VirtualNetworkRuntime.js';
import { VirtualSubscription } from './VirtualSubscription.js';
import { VirtualChannel } from './VirtualChannel.js';
import { VirtualNetworkEvent } from '../events/VirtualNetworkEvent.js';
import { WebRtcPeerSession } from '../webrtc/WebRtcPeerSession.js';
import { P2PScatterNetwork } from './P2PScatterNetwork.js';
import { MeshNetwork } from '../mesh/MeshNetwork.js';
import { ControlMessage } from './ControlMessage.js';
import { ConnectionMemory } from './ConnectionMemory.js';
import { ConnectionStep } from '../events/ConnectionStep.js';
import { ConnectionState } from '../state/ConnectionState.js';
import { VirtualControlBus } from './VirtualControlBus.js';
import { SubscriptionScope } from './SubscriptionScope.js';

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
    this.p2pNetwork = new P2PScatterNetwork(this);
    this.meshNetwork = new MeshNetwork(this);
    this.controlBus = new VirtualControlBus(this);
  }

  subscribe(subscriptionLabel, channelLabel, peerAddress, timeout, lobbyId = undefined, tableId = undefined) {
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
    this.handler(VirtualNetworkEvent.connectionStep(fields));
  }

  shouldUseMeshFirst(peerAddress) {
    return this.connectionMemory.shouldUseMeshFirst(Address.from(peerAddress).toString());
  }

  rememberP2PTimeout(peerAddress) {
    this.connectionMemory.rememberP2PTimeout(Address.from(peerAddress).toString());
  }

  registerConnectedSubscription(subscription) {
    this.connectionMemory.rememberConnected(subscription.peerAddress.toString());
    this.connectedSubscriptions.set(subscription.peerAddress.toString(), subscription);
    this.meshNetwork.reportConnected(subscription);
  }

  unregisterConnectedSubscription(subscription) {
    const peerAddress = subscription.peerAddress.toString();
    if (this.connectedSubscriptions.get(peerAddress) === subscription) {
      this.connectedSubscriptions.delete(peerAddress);
    }
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
    this.sendControlToConnectedPeers(message);
  }

  sendControlLocally(message) {
    this.controlBus.post(message);
  }

  sendControlToConnectedPeers(message) {
    if (message.ttl <= 0) return;
    this.connectedSubscriptions.forEach((subscription) => {
      if (!subscription.peerSession?.isConnected()) return;
      subscription.peerSession.sendControl(message);
      this.emitRelayedSignal(message, subscription);
    });
  }

  handleControlMessage(message, source = 'local') {
    if (!message || message.senderInstanceId === this.instanceId) return;
    if (this.seenControlMessages.has(message.id)) return;
    this.seenControlMessages.add(message.id);
    if (source === 'peer') {
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

    if (message.to !== this.address.toString() && message.ttl > 1) {
      this.sendControlToConnectedPeers(ControlMessage.create(
        message,
        this.runtime,
        this.address.toString(),
        this.config.controlTtl,
        this.instanceId,
      ).nextHop(this.address.toString(), this.instanceId));
    }
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
    const offer = await peerSession.createOffer();
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
    if (message.to !== this.address.toString()) return;
    if (!this.acceptsControlTarget(message)) return;
    const subscription = this.findSubscriptionByMessage(message);
    if (!subscription) return;
    if (subscription.state === ConnectionState.PEER_CONNECTED) return;
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
    const peerSession = subscription.peerSession ?? this.createPeerSession(message.from);
    subscription.attachPeerSession(peerSession);
    await peerSession.applyAnswer({ type: 'answer', sdp: message.sdp });
  }

  async handleMeshTriggerOffer(message, enqueue) {
    const subscription = this.findSubscriptionByPeer(message.target, message.lobbyId, message.tableId);
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
    const subscription = this.findSubscriptionByPeer(message.from, message.lobbyId, message.tableId);
    if (!subscription) return;
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
    const peerSession = subscription.peerSession ?? this.createPeerSession(message.from);
    subscription.attachPeerSession(peerSession);
    await peerSession.applyAnswer({ type: 'answer', sdp: message.sdp });
  }

  handleMeshRouteAvailable(message) {
    const subscription = this.findSubscriptionByPeer(message.target, message.lobbyId, message.tableId);
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
    const existing = this.subscriptions.get(scope.subscriptionKey());
    if (existing) return existing;

    const subscription = new VirtualSubscription({
      network: this,
      subscriptionLabel: message.subscriptionLabel,
      channelLabel: message.channelLabel,
      peerAddress: message.from,
      timeout: 10_000,
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

  stopSubscription(subscription) {
    subscription.stop();
    this.controlBus.unregister(subscription);
    this.subscriptions.delete(subscription.scope().subscriptionKey());
    this.channels.delete(subscription.scope().channelKey());
    this.connectedSubscriptions.delete(subscription.peerAddress.toString());
  }

  prepareIncomingOffer(subscription, message) {
    if (subscription.canBeginNegotiation()) return true;
    if (subscription.state === ConnectionState.PEER_CONNECTED && subscription.tableId === '0') return false;
    if (subscription.state !== ConnectionState.PEER_CONNECTED && subscription.peerSession?.isConnected()) return false;
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
    return false;
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
    return peerSession;
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

  shouldCreateP2POffer(message) {
    const subscription = this.findSubscriptionByMessage(message);
    if (!subscription) return true;
    if (subscription.peerAddress.toString() !== Address.from(message.from).toString()) return true;
    if (subscription.state !== ConnectionState.TRY_P2P_NETWORK) return true;
    return this.address.toString() < Address.from(message.from).toString();
  }
}
