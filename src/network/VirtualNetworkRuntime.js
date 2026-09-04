export class VirtualNetworkRuntime {
  constructor() {
    this.setTimer = globalThis.setTimeout.bind(globalThis);
    this.clearTimer = globalThis.clearTimeout.bind(globalThis);
    this.crypto = globalThis.crypto;
    this.RTCPeerConnection = globalThis.RTCPeerConnection;
    this.BroadcastChannel = globalThis.BroadcastChannel;
  }
}
