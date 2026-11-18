export class PeerSessionId {
  constructor(value) {
    this.value = String(value ?? '');
    if (!/^[a-z0-9-]+$/i.test(this.value)) throw new Error('A parent Lobby peerId is required.');
  }

  static random(runtime) {
    return new PeerSessionId(runtime.crypto.randomUUID()).toString();
  }

  static from(value) {
    return new PeerSessionId(value).toString();
  }

  toString() {
    return this.value;
  }
}
