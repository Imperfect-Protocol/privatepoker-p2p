import { VirtualNetworkEventType } from './VirtualNetworkEventType.js';

export class VirtualNetworkEvent {
  constructor(type, fields = {}) {
    this.type = type;
    Object.assign(this, fields);
  }

  static peerConnected(fields) {
    return new VirtualNetworkEvent(VirtualNetworkEventType.PEER_CONNECTED, fields);
  }

  static peerWaiting(fields) {
    return new VirtualNetworkEvent(VirtualNetworkEventType.PEER_WAITING, fields);
  }

  static connectionTimeout(fields) {
    return new VirtualNetworkEvent(VirtualNetworkEventType.CONNECTION_TIMEOUT, fields);
  }

  static peerDisconnected(fields) {
    return new VirtualNetworkEvent(VirtualNetworkEventType.PEER_DISCONNECTED, fields);
  }

  static messageDelivered(fields) {
    return new VirtualNetworkEvent(VirtualNetworkEventType.MESSAGE_DELIVERED, fields);
  }

  static messageReceived(fields) {
    return new VirtualNetworkEvent(VirtualNetworkEventType.MESSAGE_RECEIVED, fields);
  }

  static connectionFailed(fields) {
    return new VirtualNetworkEvent(VirtualNetworkEventType.CONNECTION_FAILED, fields);
  }

  static connectionStep(fields) {
    return new VirtualNetworkEvent(VirtualNetworkEventType.CONNECTION_STEP, fields);
  }

  static meshPollError(fields) {
    return new VirtualNetworkEvent(VirtualNetworkEventType.MESH_POLL_ERROR, fields);
  }
}
