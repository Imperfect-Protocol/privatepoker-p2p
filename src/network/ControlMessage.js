export class ControlMessage {
  constructor(fields) {
    this.id = fields.id;
    this.type = fields.type;
    this.sender = fields.sender;
    this.from = fields.from;
    this.to = fields.to;
    this.subscriptionLabel = fields.subscriptionLabel;
    this.channelLabel = fields.channelLabel;
    this.lobbyId = fields.lobbyId;
    this.tableId = fields.tableId;
    this.via = fields.via;
    this.flowId = fields.flowId;
    this.sdp = fields.sdp;
    this.ttl = fields.ttl;
  }

  static create(fields, runtime, sender, ttl) {
    return new ControlMessage({
      ...fields,
      id: fields.id ?? runtime.crypto.randomUUID(),
      sender,
      ttl: fields.ttl ?? ttl,
    });
  }

  nextHop(sender) {
    return new ControlMessage({
      ...this,
      sender,
      ttl: this.ttl - 1,
    });
  }
}
