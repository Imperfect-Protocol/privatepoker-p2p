export class P2PMessage {
  constructor(data) {
    this.data = data;
  }

  static from(data) {
    return data instanceof P2PMessage ? data : new P2PMessage(data);
  }
}
