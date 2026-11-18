export const TabMessageType = Object.freeze({
  FIND_PEER_REQUEST: 'lobby-find-peer.request',
  FIND_PEER_RESPONSE: 'lobby-find-peer.response',
});

/**
 * Value objects exchanged between a Table tab and its Lobby tab.
 *
 * These are messages only. No instance stores them as state and the
 * BroadcastChannel never becomes a durable log.
 */
export class TabMessage {
  static findPeerRequest(fields) {
    return {
      type: TabMessageType.FIND_PEER_REQUEST,
      requestId: fields.requestId,
      requesterInstanceId: fields.requesterInstanceId,
      peerAddress: String(fields.peerAddress),
      subscriptionLabel: fields.subscriptionLabel,
      channelLabel: fields.channelLabel,
      lobbyId: String(fields.lobbyId),
      tableId: String(fields.tableId),
    };
  }

  static findPeerResponse(fields) {
    return {
      type: TabMessageType.FIND_PEER_RESPONSE,
      status: fields.status,
      requestId: fields.requestId,
      peerAddress: String(fields.peerAddress),
      subscriptionLabel: fields.subscriptionLabel,
      channelLabel: fields.channelLabel,
      lobbyId: String(fields.lobbyId),
      tableId: String(fields.tableId),
    };
  }
}
