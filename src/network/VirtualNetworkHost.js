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

export class VirtualNetworkHost {
  constructor(handlerFunction, address, privateKey, config = new VirtualNetworkConfig(), runtime = new VirtualNetworkRuntime()) {
    this.handler = handlerFunction;
    this.address = Address.from(address);
    this.privateKey = privateKey;
    this.config = config instanceof VirtualNetworkConfig ? config : new VirtualNetworkConfig(config);
    this.runtime = runtime;
    this.subscriptions = new Map();
    this.channels = new Map();
    this.connectedSubscriptions = new Map();
    this.seenControlMessages = new Set();
    this.connectionMemory = new ConnectionMemory();
    this.p2pNetwork = new P2PScatterNetwork(this);
    this.meshNetwork = new MeshNetwork(this);
    this.controlBus = this.openControlBus();
  }

  subscribe(subscriptionLabel, channelLabel, peerAddress, timeout, lobbyId = undefined, tableId = undefined) {
    const existing = this.subscriptions.get(subscriptionLabel);
    if (existing) this.unsubscribe(subscriptionLabel);

    const subscription = new VirtualSubscription({
      network: this,
      subscriptionLabel,
      channelLabel,
      peerAddress,
      timeout,
      lobbyId: lobbyId ?? this.config.lobbyId,
      tableId: tableId ?? this.config.tableId,
    });
    this.subscriptions.set(subscriptionLabel, subscription);
    this.channels.set(channelLabel, new VirtualChannel(channelLabel, subscription, this));
    subscription.start().catch((error) => subscription.stateMachine.failed(error));
    return Result.ok();
  }

  unsubscribe(subscriptionLabel) {
    const subscription = this.subscriptions.get(subscriptionLabel);
    if (!subscription) return Result.ok();
    subscription.stop();
    this.subscriptions.delete(subscriptionLabel);
    this.channels.delete(subscription.channelLabel);
    this.connectedSubscriptions.delete(subscription.peerAddress.toString());
    return Result.ok();
  }

  send(channelLabel, message) {
    const channel = this.channels.get(channelLabel);
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

  hasConnectedPeers() {
    return this.connectedSubscriptions.size > 0;
  }

  openControlBus() {
    if (!this.runtime.BroadcastChannel) return null;
    const controlBus = new this.runtime.BroadcastChannel(`${this.config.broadcastPrefix}:control`);
    controlBus.onmessage = (event) => this.handleControlMessage(event.data);
    return controlBus;
  }

  broadcastControl(fields) {
    const message = ControlMessage.create(fields, this.runtime, this.address.toString(), this.config.controlTtl);
    this.seenControlMessages.add(message.id);
    this.sendControlLocally(message);
    this.sendControlToConnectedPeers(message);
  }

  sendControlLocally(message) {
    this.controlBus?.postMessage(message);
  }

  sendControlToConnectedPeers(message) {
    if (message.ttl <= 0) return;
    this.connectedSubscriptions.forEach((subscription) => {
      if (!subscription.peerSession?.isConnected()) return;
      subscription.peerSession.sendControl(message);
    });
  }

  handleControlMessage(message) {
    if (!message || message.sender === this.address.toString()) return;
    if (this.seenControlMessages.has(message.id)) return;
    this.seenControlMessages.add(message.id);

    if (message.type === 'mesh-announce') this.handleMeshAnnounce(message);
    if (message.type === 'p2p-mst-announce') this.handleP2PAnnounce(message);
    if (message.type === 'sdp-offer') void this.handleSdpOffer(message);
    if (message.type === 'sdp-answer') void this.handleSdpAnswer(message);

    if (message.to !== this.address.toString() && message.ttl > 1) {
      this.sendControlToConnectedPeers(ControlMessage.create(message, this.runtime, this.address.toString(), this.config.controlTtl).nextHop(this.address.toString()));
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
    this.emitConnectionStep({
      step: ConnectionStep.ANNOUNCE_RECEIVED,
      via: 'p2p',
      from: message.from,
      to: message.to,
      lobbyId: message.lobbyId,
      tableId: message.tableId,
    });
    void this.sendOffer(message.from, message.subscriptionLabel, message.channelLabel, 'p2p', message.flowId, message.lobbyId, message.tableId);
  }

  async sendOffer(peerAddress, subscriptionLabel, channelLabel, via, flowId = '', lobbyId = undefined, tableId = undefined) {
    const subscription = this.findOrCreateRemoteSubscription({
      from: peerAddress,
      subscriptionLabel,
      channelLabel,
      lobbyId: lobbyId ?? this.config.lobbyId,
      tableId: tableId ?? this.config.tableId,
    });
    if (!subscription.canBeginNegotiation()) return;
    const peerSession = this.createPeerSession(peerAddress);
    this.emitConnectionStep({
      step: ConnectionStep.OFFER_CREATED,
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
    const subscription = this.findOrCreateRemoteSubscription(message);
    if (!subscription.canBeginNegotiation()) return;
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
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      flowId: message.flowId,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      sdp: answer.sdp,
    });
  }

  async handleSdpAnswer(message) {
    if (message.to !== this.address.toString()) return;
    const subscription = this.subscriptions.get(message.subscriptionLabel);
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
    const subscription = this.findSubscriptionByPeer(message.target);
    if (!subscription) return;
    if (!subscription.canBeginNegotiation()) return;
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
    if (!subscription.canBeginNegotiation()) return;
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
    const subscription = this.findSubscriptionByPeer(message.from);
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
    const subscription = this.findSubscriptionByPeer(message.target);
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

  findSubscriptionByPeer(peerAddress) {
    const address = Address.from(peerAddress).toString();
    for (const subscription of this.subscriptions.values()) {
      if (subscription.peerAddress.toString() === address) return subscription;
    }
    return null;
  }

  findOrCreateRemoteSubscription(message) {
    const existing = this.subscriptions.get(message.subscriptionLabel);
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
    this.subscriptions.set(message.subscriptionLabel, subscription);
    this.channels.set(message.channelLabel, new VirtualChannel(message.channelLabel, subscription, this));
    return subscription;
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
    peerSession.onControl = (message) => this.handleControlMessage(message);
    return peerSession;
  }
}
