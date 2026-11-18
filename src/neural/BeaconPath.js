/**
 * One ordered address path carried by a beacon.
 *
 * A two-node path is a direct edge (`A->B`). A longer path is a route reminder
 * installed by a completed announce/feedback round trip (`A->X->N->B`). The same
 * value type covers both; consumers distinguish them with `isEdge`.
 *
 * A path is only ever advertised by a node that appears in it, and only to the
 * neighbour that is its next hop. That keeps the reminder travelling in one
 * direction instead of being gossiped as global topology.
 */
export class BeaconPath {
  constructor(nodes) {
    const ordered = [...nodes].map(String);
    if (ordered.length < 2) {
      throw new Error('a beacon path needs at least two addresses');
    }
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index] === ordered[index - 1]) {
        throw new Error(`beacon path repeats ${ordered[index]} back to back`);
      }
    }
    this.nodes = ordered;
  }

  static edge(first, second) {
    return new BeaconPath([first, second]);
  }

  static from(values) {
    return values instanceof BeaconPath ? values : new BeaconPath(values);
  }

  get key() {
    return this.nodes.join('>');
  }

  get isEdge() {
    return this.nodes.length === 2;
  }

  nextHopFrom(address) {
    const at = this.nodes.indexOf(String(address));
    if (at < 0 || at >= this.nodes.length - 1) return null;
    return this.nodes[at + 1];
  }

  contains(address) {
    return this.nodes.includes(String(address));
  }

  reversed() {
    return new BeaconPath([...this.nodes].reverse());
  }

  toArray() {
    return [...this.nodes];
  }
}
