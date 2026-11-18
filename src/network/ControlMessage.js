export class ControlMessage {
  constructor(fields) {
    const known = [
      'id', 'type', 'sender', 'senderInstanceId', 'senderRole', 'targetRole',
      'targetInstanceId', 'initiatorInstanceId', 'responderInstanceId', 'from',
      'to', 'subscriptionLabel', 'channelLabel', 'lobbyId', 'tableId', 'via',
      'flowId', 'sdp', 'waitingReason', 'decisionReason', 'ttl', 'neural',
    ];
    for (const key of Object.keys(fields)) this[key] = fields[key];
    for (const key of known) this[key] = fields[key];
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

  /** Plain JSON-safe fields for the neural signal payload. */
  toFields() {
    return { ...this };
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
