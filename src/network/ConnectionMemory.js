export class ConnectionMemory {
  constructor() {
    this.p2pTimedOutPeers = new Set();
  }

  rememberP2PTimeout(peerAddress) {
    this.p2pTimedOutPeers.add(String(peerAddress));
  }

  shouldUseMeshFirst(peerAddress) {
    return this.p2pTimedOutPeers.has(String(peerAddress));
  }

  rememberConnected(peerAddress) {
    this.p2pTimedOutPeers.delete(String(peerAddress));
  }
}
