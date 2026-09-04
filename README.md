# privatepoker-p2p

`privatepoker-p2p` is the standalone Private Poker virtual network library.

The public surface is intentionally small:

```js
const virtualNet = new VirtualNetwork(handlerFunction, address, privateKey);

virtualNet.subscribe('inbound', 'outbound', peerAddress, 10_000, lobbyId, tableId);
virtualNet.unsubscribe('inbound');
virtualNet.send('outbound', message);
```

The caller does not know whether signalling used an existing P2P route, collaborative route discovery, or mesh fallback. The caller receives every state change and message through the single handler function.

## Events

The handler receives these event types:

- `PeerConnected`
- `ConnectionTimeout`
- `PeerDisconnected`
- `MessageDelivered`
- `MessageReceived`
- `ConnectionFailed`
- `ConnectionStep`
- `MeshPollError`

Connection protocol notifications are emitted as `ConnectionStep` events. The important step names are:

- `AnnounceSent`
- `AnnounceReceived`
- `OfferRequested`
- `OfferSent`
- `OfferReceived`
- `AnswerSent`
- `AnswerReceived`

## Connection Model

`subscribe(subscriptionLabel, channelLabel, peerAddress, timeout, lobbyId, tableId)` creates one labelled receiving subscription and one labelled sending channel for a poker table context.

The connection attempt is driven by `ConnectionAttemptStateMachine`:

- `Initial`
- `TryP2PNetwork`
- `TryMeshNode`
- `ConnectionTimeout`
- `PeerConnected`
- `Failed`
- `Disconnected`

When the local peer already has connected peers, the first attempt uses P2P scatter discovery. When no peers are connected, or when the previous P2P attempt timed out, the next attempt uses mesh fallback.

## Mesh Fallback

Pass mesh endpoints in `VirtualNetworkConfig` when the network should use deployed private-mesh nodes:

```js
const virtualNet = new VirtualNetwork(handlerFunction, address, privateKey, {
  meshUrls: [
    'http://127.0.0.1:3001/mesh',
    'http://127.0.0.1:3002/mesh',
  ],
});
```

The mesh adapter speaks the Postgres-backed private-mesh protocol:

- `bootstrap-announce`
- `trigger-offer`
- `bootstrap-interest`
- `bootstrap-offer`
- `bootstrap-answer`
- `p2p-route-available`
- `link-connected`
- `link-failed`

SDP payloads are carried as hex-encoded JSON under `signal.encryptedData`, which matches private-mesh validation while keeping the caller-facing `P2PMessage` unchanged.

## Test App

`../privatepoker-p2p-testapp` imports this package and creates two peers. Peer A uses `http://127.0.0.1:3001/mesh`; Peer B uses `http://127.0.0.1:3002/mesh`.

The default context is `1/1`, so two separate browser windows opened at the test app can discover each other through private-mesh. The app also has a `Fresh context` link for isolated debugging runs.
