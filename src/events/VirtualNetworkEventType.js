export const VirtualNetworkEventType = Object.freeze({
  PEER_CONNECTED: 'PeerConnected',
  PEER_WAITING: 'PeerWaiting',
  PEER_WAIT_REQUEST: 'PeerWaitRequest',
  PEER_WAIT_ACCEPTED: 'PeerWaitAccepted',
  PEER_WAIT_REJECTED: 'PeerWaitRejected',
  CONNECTION_TIMEOUT: 'ConnectionTimeout',
  PEER_DISCONNECTED: 'PeerDisconnected',
  MESSAGE_DELIVERED: 'MessageDelivered',
  MESSAGE_RECEIVED: 'MessageReceived',
  CONNECTION_FAILED: 'ConnectionFailed',
  CONNECTION_STEP: 'ConnectionStep',
  MESH_POLL_ERROR: 'MeshPollError',
});
