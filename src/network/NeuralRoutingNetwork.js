import { ConnectionStep } from '../events/ConnectionStep.js';
import { NeuralNode } from '../neural/NeuralNode.js';
import { NeuralRoutingConfig } from '../neural/NeuralRoutingConfig.js';
import { NeuralTrace } from '../neural/NeuralTrace.js';

/**
 * Adapter between `VirtualNetworkHost` and the neural overlay.
 *
 * The host only knows three verbs: announce a target, hand over an inbound
 * bundle, and tell the overlay that a direct edge appeared or disappeared.
 * Everything else — beacons, stun windows, embeddings, tensor learning,
 * compression and fallback — belongs to `NeuralNode`.
 */
export class NeuralRoutingNetwork {
  constructor(network, fields = {}) {
    this.network = network;
    this.config = (fields.config instanceof NeuralRoutingConfig
      ? fields.config
      : new NeuralRoutingConfig({
        ...(network.config.neural ?? {}),
        ...fields.config,
      })).validate();
    this.trace = new NeuralTrace('routing', {
      address: network.address.toString(),
      instanceId: network.instanceId,
      enabled: this.config.traceEnabled,
    });
    this.node = new NeuralNode({
      address: network.address.toString(),
      instanceId: network.instanceId,
      config: this.config,
      runtime: network.runtime,
      trace: this.trace,
      neighbours: () => this.network.getConnectedPeers(),
      transport: {
        sendBundle: (destination, bundle) => this.network.sendNeuralBundle(destination, bundle),
        deliverControl: (payload, from) => this.network.deliverNeuralControl(payload, from),
        requestMeshFallback: (target) => this.network.requestMeshFallback(target),
      },
    });
  }

  start() {
    this.node.start();
  }

  stop() {
    this.node.stop();
  }

  /**
   * Ask the overlay to find `subscription.peerAddress`. This only queues one
   * addressed announce; the stun window decides when and where it actually goes.
   */
  async findPeer(subscription) {
    const peerAddress = subscription.peerAddress.toString();
    this.network.emitConnectionStep({
      step: ConnectionStep.ANNOUNCE_SENT,
      via: 'neural',
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      peerAddress,
    });
    this.node.requestAnnounce(peerAddress, {
      type: 'p2p-mst-announce',
      from: this.network.address.toString(),
      to: peerAddress,
      senderRole: this.network.config.role,
      targetRole: this.network.config.role,
      initiatorInstanceId: this.network.instanceId,
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
    });
  }

  /** Route an addressed control message through the overlay. */
  sendTo(targetAddress, fields) {
    this.node.requestAnnounce(String(targetAddress), fields);
  }

  receiveBundle(bundle, senderAddress) {
    void this.node.receive(bundle, senderAddress);
  }

  neighbourAdded(peerAddress) {
    this.node.confirmNeighbour(peerAddress);
  }

  neighbourRemoved(peerAddress) {
    this.node.neighbourRemoved(peerAddress);
  }
}
