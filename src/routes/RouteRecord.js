export class RouteRecord {
  constructor(fields = {}) {
    this.ownerAddress = RouteRecord.address(fields.ownerAddress);
    this.peerAddress = RouteRecord.address(fields.peerAddress);
    this.lobbyId = String(fields.lobbyId ?? '1');
    this.tableId = String(fields.tableId ?? '1');
    this.backgroundTableId = String(fields.backgroundTableId ?? '0');
    this.createdAt = Number(fields.createdAt ?? Date.now());
  }

  static address(value) {
    return String(value ?? '').toLowerCase();
  }

  static from(fields = {}) {
    return new RouteRecord(fields);
  }

  peerKey() {
    return [
      this.ownerAddress,
      this.peerAddress,
      this.lobbyId,
      this.backgroundTableId,
    ].join(':');
  }

  owns(ownerAddress, lobbyId) {
    return (
      this.ownerAddress === RouteRecord.address(ownerAddress)
      && this.lobbyId === String(lobbyId ?? this.lobbyId)
    );
  }

  toJSON() {
    return {
      ownerAddress: this.ownerAddress,
      peerAddress: this.peerAddress,
      lobbyId: this.lobbyId,
      tableId: this.tableId,
      backgroundTableId: this.backgroundTableId,
      createdAt: this.createdAt,
    };
  }
}
