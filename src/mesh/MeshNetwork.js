import { MeshPollSession } from './MeshPollSession.js';
import { MeshSignal } from './MeshSignal.js';
import { VirtualNetworkEvent } from '../events/VirtualNetworkEvent.js';
import { ConnectionStep } from '../events/ConnectionStep.js';

export class MeshNetwork {
  constructor(network) {
    this.network = network;
    this.sessions = new Map();
  }

  close() {
    this.sessions.forEach((session) => session.stop());
    this.sessions.clear();
  }

  async findPeer(subscription) {
    const discoveryScope = this.network.backgroundKeeper.discoveryScope(subscription);
    if (this.network.config.meshUrls.length > 0) {
      this.network.emitConnectionStep({
        step: ConnectionStep.ANNOUNCE_SENT,
        via: 'mesh',
        subscriptionLabel: discoveryScope.subscriptionLabel,
        channelLabel: discoveryScope.channelLabel,
        lobbyId: discoveryScope.lobbyId,
        tableId: discoveryScope.tableId,
        peerAddress: discoveryScope.peerAddress.toString(),
      });
      this.pollSession(discoveryScope).enqueue({
        type: 'bootstrap-announce',
        peer: this.network.address.toString(),
        lookingFor: [discoveryScope.peerAddress.toString()],
      });
      return;
    }

    this.network.emitConnectionStep({
      step: ConnectionStep.ANNOUNCE_SENT,
      via: 'mesh',
      subscriptionLabel: discoveryScope.subscriptionLabel,
      channelLabel: discoveryScope.channelLabel,
      lobbyId: discoveryScope.lobbyId,
      tableId: discoveryScope.tableId,
      peerAddress: discoveryScope.peerAddress.toString(),
    });
    this.network.broadcastControl({
      type: 'mesh-announce',
      from: this.network.address.toString(),
      to: discoveryScope.peerAddress.toString(),
      subscriptionLabel: discoveryScope.subscriptionLabel,
      channelLabel: discoveryScope.channelLabel,
      lobbyId: discoveryScope.lobbyId,
      tableId: discoveryScope.tableId,
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
    const scope = this.network.backgroundKeeper.discoveryScope(subscription);
    return {
      type: 'bootstrap-interest',
      signal: MeshSignal.fromSession({
        kind: 'offer',
        flowId,
        from: this.network.address.toString(),
        to: scope.peerAddress.toString(),
        lobbyId: scope.lobbyId,
        tableId: scope.tableId,
        subscriptionLabel: scope.subscriptionLabel,
        channelLabel: scope.channelLabel,
        sdp,
      }),
    };
  }

  createAnswerMessage(subscription, flowId, sdp) {
    const scope = this.network.backgroundKeeper.discoveryScope(subscription);
    return {
      type: 'bootstrap-answer',
      signal: MeshSignal.fromSession({
        kind: 'answer',
        flowId,
        from: this.network.address.toString(),
        to: scope.peerAddress.toString(),
        lobbyId: scope.lobbyId,
        tableId: scope.tableId,
        subscriptionLabel: scope.subscriptionLabel,
        channelLabel: scope.channelLabel,
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
