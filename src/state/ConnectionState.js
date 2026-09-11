export const ConnectionState = Object.freeze({
  INITIAL: 'Initial',
  TRY_P2P_NETWORK: 'TryP2PNetwork',
  TRY_MESH_NODE: 'TryMeshNode',
  PEER_WAITING: 'PeerWaiting',
  CONNECTION_TIMEOUT: 'ConnectionTimeout',
  PEER_CONNECTED: 'PeerConnected',
  FAILED: 'Failed',
  DISCONNECTED: 'Disconnected',
});
