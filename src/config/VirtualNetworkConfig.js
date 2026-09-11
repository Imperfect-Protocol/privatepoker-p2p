export class VirtualNetworkConfig {
  constructor(fields = {}) {
    this.meshUrls = fields.meshUrls ?? [];
    this.lobbyId = fields.lobbyId ?? 'default-lobby';
    this.tableId = fields.tableId ?? 'default-table';
    this.controlTtl = fields.controlTtl ?? 8;
    this.iceGatheringTimeoutMs = fields.iceGatheringTimeoutMs ?? 10_000;
    this.iceServers = fields.iceServers ?? [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ];
    this.broadcastPrefix = fields.broadcastPrefix ?? 'privatepoker-p2p';
    this.routeOracle = fields.routeOracle ?? null;
    this.role = fields.role ?? 'peer';
  }

  rtcConfiguration() {
    return { iceServers: this.iceServers };
  }

  knowsRoute(peerAddress, lobbyId, tableId) {
    if (!this.routeOracle) return false;
    return Boolean(this.routeOracle({
      peerAddress,
      lobbyId,
      tableId,
    }));
  }
}
