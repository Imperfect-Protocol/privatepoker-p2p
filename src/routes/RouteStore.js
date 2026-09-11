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

  forget(fields) {
    const record = RouteRecord.from(fields);
    const records = this.read();
    delete records[record.peerKey()];
    this.write(records);
  }

  hasPeerRoute(fields) {
    return Boolean(this.findPeerRoute(fields));
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
