import { ConnectionStep } from '../events/ConnectionStep.js';
import { VirtualNetworkEvent } from '../events/VirtualNetworkEvent.js';
import { ConnectionState } from '../state/ConnectionState.js';
import { TabMessage } from '../tabs/TabMessage.js';
import { VirtualNetworkConsoleLogger } from '../logging/VirtualNetworkConsoleLogger.js';

/**
 * Table-tab discovery adapter.
 *
 * A Table tab has no neural node and no mesh endpoint. It asks the Lobby tab for
 * a background edge over BroadcastChannel. When the Lobby answers, the Table
 * tab publishes its normal P2P announce through that same channel; the Lobby
 * tunnels it over the background edge that it owns.
 */
export class LobbyRouteClient {
  constructor(network) {
    this.network = network;
    this.requests = new Map();
  }

  start() {}

  stop() {
    this.requests.clear();
  }

  findPeer(subscription) {
    const requestId = `${this.network.instanceId}:${subscription.scope().subscriptionKey()}`;
    this.requests.set(requestId, subscription);
    VirtualNetworkConsoleLogger.log('lobby.route.request', {
      address: this.network.address.toString(),
      requestId,
      peerAddress: subscription.peerAddress.toString(),
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
    });
    this.network.broadcastControl({
      ...TabMessage.findPeerRequest({
        requestId,
        requesterInstanceId: this.network.instanceId,
        peerAddress: subscription.peerAddress.toString(),
        subscriptionLabel: subscription.subscriptionLabel,
        channelLabel: subscription.channelLabel,
        lobbyId: subscription.lobbyId,
        tableId: subscription.tableId,
      }),
      from: this.network.address.toString(),
      to: this.network.address.toString(),
      senderRole: this.network.config.role,
      targetRole: 'lobby',
    });
    return Promise.resolve();
  }

  handleFindPeerResponse(message) {
    const subscription = this.requests.get(message.requestId);
    if (!subscription) return false;
    this.requests.delete(message.requestId);
    if (message.status !== 'route-ready') {
      VirtualNetworkConsoleLogger.log('lobby.route.failed', {
        address: this.network.address.toString(),
        requestId: message.requestId,
        peerAddress: message.peerAddress,
      });
      this.network.handler(VirtualNetworkEvent.connectionFailed({
        state: ConnectionState.FAILED,
        subscriptionLabel: subscription.subscriptionLabel,
        channelLabel: subscription.channelLabel,
        lobbyId: subscription.lobbyId,
        tableId: subscription.tableId,
        peerAddress: subscription.peerAddress.toString(),
        error: new Error('The Lobby tab could not establish a background route.'),
        errorMessage: 'The Lobby tab could not establish a background route.',
      }));
      return true;
    }

    VirtualNetworkConsoleLogger.log('lobby.route.ready', {
      address: this.network.address.toString(),
      requestId: message.requestId,
      peerAddress: message.peerAddress,
    });
    this.network.emitConnectionStep({
      step: ConnectionStep.ROUTE_AVAILABLE,
      via: 'lobby',
      flowId: message.requestId,
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    this.network.emitConnectionStep({
      step: ConnectionStep.ANNOUNCE_SENT,
      via: 'p2p',
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });
    this.network.publishDiscovery({
      type: 'p2p-mst-announce',
      from: this.network.address.toString(),
      to: subscription.peerAddress.toString(),
      senderRole: this.network.config.role,
      targetRole: 'table',
      initiatorInstanceId: this.network.instanceId,
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
    });
    return true;
  }

  sendTo() {}

  receiveBundle() {}

  neighbourAdded() {}

  neighbourRemoved() {}
}
