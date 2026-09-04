import { MeshSignalCodec } from './MeshSignalCodec.js';

export class MeshSignal {
  constructor(fields) {
    this.kind = fields.kind;
    this.flowId = fields.flowId;
    this.from = fields.from;
    this.to = fields.to;
    this.lobbyId = fields.lobbyId;
    this.tableId = fields.tableId;
    this.encryptedData = fields.encryptedData;
  }

  static fromSession(fields) {
    const codec = new MeshSignalCodec();
    return new MeshSignal({
      kind: fields.kind,
      flowId: fields.flowId,
      from: fields.from,
      to: fields.to,
      lobbyId: fields.lobbyId,
      tableId: fields.tableId,
      encryptedData: codec.encode({
        subscriptionLabel: fields.subscriptionLabel,
        channelLabel: fields.channelLabel,
        sdp: fields.sdp,
      }),
    });
  }

  static parse(signal) {
    const codec = new MeshSignalCodec();
    const payload = codec.decode(signal.encryptedData ?? signal.payload);
    return {
      kind: signal.kind,
      flowId: signal.flowId,
      from: signal.from ?? signal.sender ?? signal.originAddress,
      to: signal.to ?? signal.recipient ?? signal.targetAddress,
      lobbyId: signal.lobbyId,
      tableId: signal.tableId,
      subscriptionLabel: payload.subscriptionLabel,
      channelLabel: payload.channelLabel,
      sdp: payload.sdp,
    };
  }
}
