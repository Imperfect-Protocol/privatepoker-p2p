export class WebRtcEnvelope {
  constructor(fields) {
    this.kind = fields.kind;
    this.channelLabel = fields.channelLabel;
    this.messageData = fields.messageData;
  }

  static message(channelLabel, messageData) {
    return new WebRtcEnvelope({
      kind: 'message',
      channelLabel,
      messageData,
    });
  }

  static control(messageData) {
    return new WebRtcEnvelope({
      kind: 'control',
      messageData,
    });
  }
}
