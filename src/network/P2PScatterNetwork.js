import { ConnectionStep } from '../events/ConnectionStep.js';

export class P2PScatterNetwork {
  constructor(network) {
    this.network = network;
  }

  async findPeer(subscription) {
    this.network.emitConnectionStep({
      step: ConnectionStep.ANNOUNCE_SENT,
      via: 'p2p',
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    this.network.broadcastControl({
      type: 'p2p-mst-announce',
      from: this.network.address.toString(),
      to: subscription.peerAddress.toString(),
      senderRole: this.network.config.role,
      targetRole: this.network.config.role,
      initiatorInstanceId: this.network.instanceId,
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
    });
  }
}
