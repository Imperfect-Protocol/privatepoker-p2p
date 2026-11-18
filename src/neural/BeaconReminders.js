import { BeaconPath } from './BeaconPath.js';

/**
 * The paths this node is entitled to advertise, and the per-neighbour split.
 *
 * A node owns its direct edges and the route reminders it learned from completed
 * announces. A reminder is refreshed by every beacon interval and expires unless
 * it is renewed, so a route that stopped working ages out on its own.
 *
 * `pathsToward` is the whole split rule: a path is advertised to exactly one
 * neighbour, the next hop from this node's position on the path. Every other
 * neighbour receives the beacon's presence with no path attached.
 */
export class BeaconReminders {
  constructor(fields = {}) {
    this.address = String(fields.address);
    this.ttlMs = fields.ttlMs ?? 5_000;
    this.maxPaths = fields.maxPaths ?? 64;
    this.now = fields.now ?? (() => Date.now());
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  add(path) {
    const reminder = BeaconPath.from(path);
    if (reminder.nodes[0] !== this.address) return false;
    this.entries.set(reminder.key, { path: reminder, updatedAt: this.now() });
    this.#trim();
    return true;
  }

  rememberRoute(nodes) {
    if (nodes.length < 2) return false;
    return this.add(new BeaconPath(nodes));
  }

  /** A departed neighbour invalidates every path that used it. */
  removeNeighbour(peer) {
    const address = String(peer);
    for (const [key, entry] of this.entries) {
      if (entry.path.contains(address)) this.entries.delete(key);
    }
  }

  /** The whole row this node can advertise, before per-neighbour splitting. */
  row() {
    return new Map([...this.entries].map(([key, entry]) => [key, entry.path]));
  }

  /** Paths whose next hop toward the destination is that neighbour. */
  pathsToward(destination) {
    const neighbour = String(destination);
    const now = this.now();
    this.#prune(now);
    const paths = [];
    for (const entry of this.entries.values()) {
      if (entry.path.nextHopFrom(this.address) === neighbour) paths.push(entry.path);
    }
    return paths;
  }

  #prune(now) {
    const cutoff = now - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.updatedAt < cutoff) this.entries.delete(key);
    }
  }

  #trim() {
    if (this.entries.size <= this.maxPaths) return;
    const oldest = [...this.entries.entries()]
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt);
    for (let index = 0; index < oldest.length - this.maxPaths; index += 1) {
      this.entries.delete(oldest[index][0]);
    }
  }
}
