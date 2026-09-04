import { MeshPollSession } from './MeshPollSession.js';
import { MeshSignal } from './MeshSignal.js';
import { VirtualNetworkEvent } from '../events/VirtualNetworkEvent.js';
import { ConnectionStep } from '../events/ConnectionStep.js';

export class MeshNetwork {
  constructor(network) {
    this.network = network;
    this.sessions = new Map();
  }

  async findPeer(subscription) {
    if (this.network.config.meshUrls.length > 0) {
      this.network.emitConnectionStep({
        step: ConnectionStep.ANNOUNCE_SENT,
        via: 'mesh',
        subscriptionLabel: subscription.subscriptionLabel,
        channelLabel: subscription.channelLabel,
        lobbyId: subscription.lobbyId,
        tableId: subscription.tableId,
        peerAddress: subscription.peerAddress.toString(),
      });
      this.pollSession(subscription).enqueue({
        type: 'bootstrap-announce',
        peer: this.network.address.toString(),
        lookingFor: [subscription.peerAddress.toString()],
      });
      return;
    }

    this.network.emitConnectionStep({
      step: ConnectionStep.ANNOUNCE_SENT,
      via: 'mesh',
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    this.network.broadcastControl({
      type: 'mesh-announce',
      from: this.network.address.toString(),
      to: subscription.peerAddress.toString(),
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
    });
  }

  pollSession(subscription) {
    const key = `${subscription.lobbyId}:${subscription.tableId}:${this.network.address}`;
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const session = new MeshPollSession({
      network: this,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      peer: this.network.address.toString(),
      urls: this.network.config.meshUrls,
    });
    this.sessions.set(key, session);
    session.start();
    return session;
  }

  createInterestMessage(subscription, flowId, sdp) {
    return {
      type: 'bootstrap-interest',
      signal: MeshSignal.fromSession({
        kind: 'offer',
        flowId,
        from: this.network.address.toString(),
        to: subscription.peerAddress.toString(),
        lobbyId: subscription.lobbyId,
        tableId: subscription.tableId,
        subscriptionLabel: subscription.subscriptionLabel,
        channelLabel: subscription.channelLabel,
        sdp,
      }),
    };
  }

  createAnswerMessage(subscription, flowId, sdp) {
    return {
      type: 'bootstrap-answer',
      signal: MeshSignal.fromSession({
        kind: 'answer',
        flowId,
        from: this.network.address.toString(),
        to: subscription.peerAddress.toString(),
        lobbyId: subscription.lobbyId,
        tableId: subscription.tableId,
        subscriptionLabel: subscription.subscriptionLabel,
        channelLabel: subscription.channelLabel,
        sdp,
      }),
    };
  }

  reportConnected(subscription) {
    if (this.network.config.meshUrls.length === 0) return;
    this.pollSession(subscription).enqueue({
      type: 'link-connected',
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      from: this.network.address.toString(),
      to: subscription.peerAddress.toString(),
      target: subscription.peerAddress.toString(),
    });
  }

  reportFailed(subscription, reason) {
    if (this.network.config.meshUrls.length === 0) return;
    this.pollSession(subscription).enqueue({
      type: 'link-failed',
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      from: this.network.address.toString(),
      to: subscription.peerAddress.toString(),
      target: subscription.peerAddress.toString(),
      reason,
    });
  }

  async handleMeshMessage(message, enqueue) {
    if (message.type === 'trigger-offer') {
      await this.network.handleMeshTriggerOffer(message, enqueue);
      return;
    }

    if (message.type === 'bootstrap-offer' && message.signal) {
      await this.network.handleMeshOffer(MeshSignal.parse(message.signal), enqueue);
      return;
    }

    if (message.type === 'bootstrap-answer' && message.signal) {
      await this.network.handleMeshAnswer(MeshSignal.parse(message.signal));
      return;
    }

    if (message.type === 'p2p-route-available') {
      this.network.handleMeshRouteAvailable(message);
    }
  }

  handleMeshPollError(error) {
    this.network.handler(VirtualNetworkEvent.meshPollError({
      state: 'Failed',
      error,
      errorMessage: error?.message ?? String(error),
    }));
  }
}
