# privatepoker-p2p

Standalone, browser-only Peer-to-Peer networking for Private Poker. State belongs to the tab that creates it. Nothing is persisted in browser storage, and tabs exchange control messages only through `BroadcastChannel`.

## Lobby and table sessions

A Lobby tab creates a `LobbyP2PSession`. It generates a unique, in-memory `peerId` and owns its background P2P connections and neural routing. Its Table tabs must receive that ID when they are opened.

```js
const lobby = new LobbyP2PSession({
  handler,
  address,
  privateKey,
  lobbyId,
  meshUrls,
});

// The Lobby parent ID belongs in the Table tab's URL or launch options.
window.open(`/table?peerId=${encodeURIComponent(lobby.peerId)}`);

const table = new TableP2PSession({
  handler,
  address,
  privateKey,
  peerId: new URL(location.href).searchParams.get('peerId'),
  lobbyId,
  tableId,
});
```

The Application decides which tab belongs to which Lobby. `TableP2PSession` does not guess among available Lobbies and requires a valid parent `peerId`. Each peer's tabs use the channel `${broadcastPrefix}:${peerId}:control`, so several peers can coexist in one browser without reading each other's messages.

### Connection flow

1. `table.subscribe(peerAddress, lobbyId, tableId)` sends a find-peer request to that Table's Lobby over `BroadcastChannel`.
2. The Lobby attempts discovery over its connected P2P neighbours.
3. If discovery exhausts its retries, the **Lobby** performs mesh fallback; the Table does not create a mesh session.
4. When the background P2P connection is live, the Lobby answers with a route and keeps that connection alive. The Table signals through this route and establishes its direct Table-to-Table WebRTC connection.
5. Closing the Table tab releases only that Table's connection and state. The Lobby's background edge and independently connected tables stay alive.
6. Closing the Lobby tab releases its channels, pending work, background edges, and routing state. Existing direct table edges are not owned by it.

During discovery, the Table tab's original `(lobbyId, tableId)` is forwarded unchanged. Live Lobby-to-Lobby neighbour records are keyed only by peer address; they retain no table identity.

The application does not implement route discovery, liveness, mesh fallback, tab tunnelling, or neural routing. It constructs sessions, inherits the parent ID for Table tabs, and reacts to events. `close()` releases the session's local resources.

## Low-level API

`VirtualNetwork` remains available as the generic network API:

```js
const virtualNet = new VirtualNetwork(handlerFunction, address, privateKey);

virtualNet.subscribe('inbound', 'outbound', peerAddress, 10_000, lobbyId, tableId);
virtualNet.unsubscribe('inbound');
virtualNet.send('outbound', message);
virtualNet.setLocalStream(mediaStream); // Optional audio/video; null stops it.
virtualNet.close();
```

Media tracks ride on the data channel's `RTCPeerConnection`. Renegotiation offers and answers use perfect negotiation over the open connection. Remote media arrives as a `MediaStream` event containing `{ peerAddress, stream }`.

## Events

The handler receives:

- `PeerConnected`
- `PeerWaiting` / `PeerWaitRequest` / `PeerWaitAccepted` / `PeerWaitRejected`
- `ConnectionTimeout`
- `ConnectionFailed`
- `ConnectionStep`
- `PeerDisconnected`
- `MessageDelivered` / `MessageReceived`
- `MeshPollError`
- `MediaStream`

`ConnectionAttemptStateMachine` uses named states `Initial`, `TryP2PNetwork`, `TryMeshNode`, `PeerWaiting`, `PeerRejected`, `ConnectionTimeout`, `PeerConnected`, `Failed`, and `Disconnected`.

Signalling steps include `AnnounceSent`, `AnnounceReceived`, `OfferRequested`, `OfferSent`, `OfferReceived`, `AnswerSent`, `AnswerReceived`, and `RouteAvailable`.

## Mesh fallback

`meshUrls` is a Lobby configuration option:

```js
const lobby = new LobbyP2PSession({
  handler,
  address,
  privateKey,
  meshUrls: ['http://127.0.0.1:3001/mesh', 'http://127.0.0.1:3002/mesh'],
});
```

The mesh adapter uses `bootstrap-announce`, `trigger-offer`, `bootstrap-interest`, `bootstrap-offer`, `bootstrap-answer`, `p2p-route-available`, `link-connected`, and `link-failed`. SDP fields are carried as hex-encoded JSON in `signal.encryptedData`. The application's `P2PMessage` surface remains unchanged.

## Test App

`privatepoker-p2p-testapp` demonstrates four independent mock peers, A/B and C/D. It can run multiple Lobby parents and their table tabs in one browser and routes table-tab launches through their owning Lobby.
