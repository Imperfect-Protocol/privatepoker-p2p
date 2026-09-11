import { RouteRecord } from './RouteRecord.js';

class MemoryRouteStorage {
  constructor() {
    this.value = '{}';
  }

  getItem() {
    return this.value;
  }

  setItem(_key, value) {
    this.value = value;
  }
}

export class RouteStore {
  constructor(fields = {}) {
    this.storageKey = fields.storageKey ?? 'privatepoker-p2p:routes';
    this.routeTtlMs = Number(fields.routeTtlMs ?? 15 * 60 * 1000);
    this.liveRouteTtlMs = Number(fields.liveRouteTtlMs ?? 120_000);
    this.storage = fields.storage ?? globalThis.localStorage ?? new MemoryRouteStorage();
  }

  read() {
    try {
      return JSON.parse(this.storage.getItem(this.storageKey) || '{}');
    } catch {
      return {};
    }
  }

  write(records) {
    this.storage.setItem(this.storageKey, JSON.stringify(records));
  }

  remember(fields) {
    const record = RouteRecord.from(fields);
    const records = this.read();
    records[record.peerKey()] = record.toJSON();
    this.write(records);
    return record;
  }

  markLive(fields) {
    return this.remember({
      ...fields,
      live: true,
      liveAt: Date.now(),
      recoveringAt: 0,
    });
  }

  markRecovering(fields) {
    const record = RouteRecord.from(fields);
    const records = this.read();
    const existing = records[record.peerKey()] ?? record.toJSON();
    records[record.peerKey()] = {
      ...existing,
      live: false,
      recoveringAt: Date.now(),
    };
    this.write(records);
    return RouteRecord.from(records[record.peerKey()]);
  }

  markOwnerRecovering(fields) {
    const ownerAddress = RouteRecord.address(fields.ownerAddress);
    const lobbyId = String(fields.lobbyId ?? '');
    const backgroundTableId = String(fields.backgroundTableId ?? '0');
    const records = this.read();
    const recoveredAt = Date.now();
    Object.keys(records).forEach((key) => {
      const record = RouteRecord.from(records[key]);
      if (record.ownerAddress !== ownerAddress) return;
      if (record.lobbyId !== lobbyId) return;
      if (record.backgroundTableId !== backgroundTableId) return;
      records[key] = {
        ...records[key],
        live: false,
        recoveringAt: recoveredAt,
      };
    });
    this.write(records);
  }

  forget(fields) {
    const record = RouteRecord.from(fields);
    const records = this.read();
    delete records[record.peerKey()];
    this.write(records);
  }

  hasPeerRoute(fields) {
    return Boolean(this.findPeerRoute(fields));
  }

  hasLivePeerRoute(fields) {
    const record = this.findPeerRoute(fields);
    if (record?.live !== true) return false;
    return Date.now() - Number(record.liveAt ?? 0) <= this.liveRouteTtlMs;
  }

  findPeerRoute(fields) {
    const wanted = RouteRecord.from(fields);
    const records = this.read();
    const record = records[wanted.peerKey()];
    if (!record) return null;
    if (Date.now() - Number(record.createdAt ?? 0) > this.routeTtlMs) return null;
    return RouteRecord.from(record);
  }
}
