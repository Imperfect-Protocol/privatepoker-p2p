export class ControlMessage {
  constructor(fields) {
    this.id = fields.id;
    this.type = fields.type;
    this.sender = fields.sender;
    this.senderInstanceId = fields.senderInstanceId;
    this.senderRole = fields.senderRole;
    this.targetRole = fields.targetRole;
    this.targetInstanceId = fields.targetInstanceId;
    this.initiatorInstanceId = fields.initiatorInstanceId;
    this.responderInstanceId = fields.responderInstanceId;
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

  static create(fields, runtime, sender, ttl, senderInstanceId = undefined) {
    return new ControlMessage({
      ...fields,
      id: fields.id ?? runtime.crypto.randomUUID(),
      sender,
      senderInstanceId,
      ttl: fields.ttl ?? ttl,
    });
  }

  nextHop(sender, senderInstanceId = undefined) {
    return new ControlMessage({
      ...this,
      sender,
      senderInstanceId,
      ttl: this.ttl - 1,
    });
  }
}
