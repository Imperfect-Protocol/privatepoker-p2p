# BigPickle — privatepoker-p2p Lobby/Table Tab Refactor

## Objective

Refactor `privatepoker-p2p` so the library owns the complete Lobby-tab / Table-tab lifecycle:

- A **Lobby tab** owns all background P2P connections and all Hebbian/neural routing.
- A **Table tab** asks its Lobby tab over `BroadcastChannel`, then uses the Lobby’s live background edge to signal and create its own direct Table-to-Table connection.
- No tab ever stores state in the browser.
- The application using `privatepoker-p2p` should only construct the right session type and render UI.

## Hard invariants

1. **No browser storage, ever**
   - Forbidden: `localStorage`, `sessionStorage`, `IndexedDB`, cookies, Cache Storage, ServiceWorker, SharedWorker, or any other persistent browser storage.
   - All state is ordinary in-memory objects owned by one tab.
   - Closing a tab destroys that tab’s state.

2. **One tab owns its own state**
   - A Lobby tab owns its background subscriptions, routing tensors, pending requests, and route registry.
   - A Table tab owns its direct subscription, signalling state, and UI state.
   - No tab reaches into another tab’s memory.

3. **`BroadcastChannel` is the only inter-tab transport**
   - The channel carries messages only; it is never treated as storage.
   - Every message is a value object with a `type`, request identifiers, addresses, and payload.
   - No protocol state lives inside the channel.

4. **Lobby-first connection ownership**
   - Hebbian routing, beacons, tensors, gossip, and mesh fallback are owned by the Lobby tab.
   - A Table tab does not run the neural overlay.
   - A Table tab uses a Lobby edge as a signalling tunnel before creating its own direct edge.

5. **Library boundary**
   - All protocol and lifecycle logic belongs in `privatepoker-p2p`.
   - The application may construct `LobbyP2PSession` and `TableP2PSession`, receive events, and render UI.
   - The application must not implement route discovery, route liveness, mesh fallback, or tab messaging.
   - An optional self-contained browser bootstrap file may be provided for apps that want to include a public JavaScript file, but it may only instantiate the library’s `BroadcastChannel` bridge; it must not contain protocol logic.

## Current state to preserve

- `VirtualControlBus` is already `BroadcastChannel`-only.
- `LiveRouteRegistry` is already transient in-memory state.
- The neural subsystem under `src/neural/` is working and tested.
- `MeshNetwork` already supports bootstrap announce/answer.
- `VirtualNetworkHost`, `VirtualSubscription`, and `WebRtcPeerSession` already provide the transport primitives.
- The testapp currently owns too much orchestration through `LobbyRouteKeeper`, `TableRoutePublisher`, and route-probe logic; that must move into the library.

## Target architecture

### Browser-level topology

```text
Table tab A
  ↕ BroadcastChannel
Lobby tab A
  ↕ P2P background edge / neural gossip / mesh fallback
Lobby tab B
  ↕ BroadcastChannel
Table tab B
```

Once the Lobby tabs are connected:

```text
Table A --tunnel--> Lobby A --P2P--> Lobby B --tunnel--> Table B
```

After Table A and Table B finish signalling, they create their own direct edge:

```text
Table A <---------------- direct WebRTC edge ----------------> Table B
```

The Lobby edge remains alive after either Table tab closes.

## New library components

### 1. `BrowserTabBus`

A thin `BroadcastChannel` wrapper.

Responsibilities:

- Open one protocol channel, e.g. `privatepoker-p2p:tabs`.
- Publish typed value objects.
- Dispatch incoming messages to one local listener.
- Close cleanly.
- Log every publish/receive as debug/trace.

It must not:

- Store messages.
- Deduplicate messages.
- Make routing decisions.
- Know about Lobby or Table semantics.

### 2. `TabMessage`

A discriminated union of tab messages, for example:

- `find-peer.request`
  - `requestId`
  - `ownerAddress`
  - `peerAddress`
  - `lobbyId`
  - `tableId`
  - `requesterInstanceId`
- `find-peer.response`
  - `requestId`
  - `status`: `route-ready` | `route-failed` | `lobby-missing`
- `lobby-edge.ready`
  - `requestId`
  - `peerAddress`
  - `lobbyId`
  - `edgeId`
- `tunnel.message`
  - `requestId`
  - `originInstanceId`
  - `targetInstanceId`
  - `peerAddress`
  - `lobbyId`
  - `tableId`
  - `direction`: `announcing` | `answering`
  - `payload`
- `table.closed`
- `lobby.closed`
- `lobby.heartbeat`

Every message must include enough identifiers to route it without shared state.

### 3. `LobbyP2PSession`

The Lobby tab’s library-level entry point.

Owns:

- One `VirtualNetworkHost` configured for role `lobby`.
- One `NeuralRoutingNetwork`.
- One `MeshNetwork`.
- One `BackgroundConnectionKeeper`.
- One `FindPeerService`.
- One `TableTunnelServer`.

Public surface:

- `start()`
- `stop()`
- `acceptWaitingRequest(request)`
- `rejectWaitingRequest(request)`
- event callback for UI and logging

It listens on `BrowserTabBus` and answers table requests.

### 4. `BackgroundConnectionKeeper`

One Lobby-owned background edge per `(ownerAddress, peerAddress, lobbyId)`.

State machine:

```text
Idle
  -> Finding
  -> Gossiping
  -> MeshFallback
  -> Connected
  -> Recovering
  -> Closed
```

Responsibilities:

- Reuse an already-connected background edge.
- Create a background subscription when a table requests a peer.
- Keep the edge alive after table tabs close.
- Recover a failed edge.
- Drop all state when the Lobby tab closes.

It must not use persisted liveness markers. A route is live only while this Lobby tab owns a connected subscription and refreshes it in memory.

### 5. `FindPeerService`

Handles table requests from `BrowserTabBus`.

Flow:

1. Receive `find-peer.request`.
2. If the requested background edge is already connected, reply `route-ready`.
3. Otherwise create or reuse a `BackgroundConnectionKeeper` entry.
4. Ask `NeuralRoutingNetwork` to announce over gossip.
5. If gossip is exhausted, ask `MeshNetwork` to announce.
6. When the Lobby edge connects, reply `route-ready`.
7. If both paths fail, reply `route-failed`.

The Lobby performs mesh fallback. A table with a live Lobby tab never bypasses the Lobby to contact the mesh directly.

If no Lobby tab responds at all, the table enters `WaitingForLobby`. A future lobby-less direct mesh mode may be an explicit opt-in, but it is not part of this refactor.

### 6. `TableTunnelServer`

Runs inside `LobbyP2PSession`.

Responsibilities:

- Receive `tunnel.message` from the local Table tab.
- Forward it over the Lobby’s background P2P edge to the remote Lobby.
- Receive tunnelled messages from the remote Lobby.
- Dispatch them to the local Table tab over `BrowserTabBus`.
- If no matching Table tab exists, surface a `PeerWaitRequest` event.

It never stores tunnel payloads.

### 7. `TableP2PSession`

The Table tab’s library-level entry point.

Owns:

- One `VirtualNetworkHost` configured for role `table`.
- No `NeuralRoutingNetwork`.
- One `LobbySignallingClient`.
- One direct `VirtualSubscription`.

Public surface:

- `subscribe(peerAddress, lobbyId, tableId)`
- `unsubscribe()`
- `send(message)`
- `close()`
- event callback for UI and logging

It must not expose route discovery, route liveness, mesh selection, or tab-bus details.

### 8. `LobbySignallingClient`

Runs inside `TableP2PSession`.

Responsibilities:

- Publish `find-peer.request` on `BrowserTabBus`.
- Wait for `find-peer.response`.
- On `route-ready`, send the table’s own SDP offer through `tunnel.message`.
- Receive the remote answer through the same tunnel.
- Complete the direct Table-to-Table WebRTC connection.
- On `route-failed`, surface a failed connection event.

### 9. `ConnectionDirection`

A tiny explicit enum:

- `announcing`
- `answering`

Direction rules:

- The Lobby background edge is bidirectional and symmetric.
- The announcing Table tab owns the inbound scope for receiving the remote side’s answer and uses the outbound channel for its offer.
- The answering Table tab owns the mirrored scope: its outbound path returns the answer, and its inbound path receives the announcing tab’s offer.
- The two direct table subscriptions must remain explicitly scoped so a renegotiation cannot replace the Lobby background edge.

## Connection flows

### 1. Table requests a peer and a Lobby route exists

```text
Table A -> find-peer.request -> Lobby A
Lobby A -> route-ready -> Table A
Table A -> tunnel.message(offer) -> Lobby A
Lobby A -> P2P -> Lobby B
Lobby B -> tunnel.message(offer) -> Table B
Table B -> tunnel.message(answer) -> Lobby B
Lobby B -> P2P -> Lobby A
Lobby A -> tunnel.message(answer) -> Table A
Table A <---------------- direct edge ----------------> Table B
```

### 2. Table requests a peer and no Lobby route exists

```text
Table A -> find-peer.request -> Lobby A
Lobby A -> neural gossip announce
         -> if exhausted -> mesh announce
Lobby A <-> Lobby B background edge connects
Lobby A -> route-ready -> Table A
... same tunnelled offer/answer flow ...
```

### 3. Table tab closes

```text
Table A -> table.closed -> Lobby A
Table A closes its direct subscription
Lobby A keeps its background edge to Lobby B
```

The table tab’s state is destroyed. The Lobby tab’s background state remains.

### 4. Table tab reopens

```text
Table A -> find-peer.request -> Lobby A
Lobby A already owns a live background edge
Lobby A -> route-ready -> Table A
Table A tunnels a fresh offer
```

### 5. Lobby tab closes

```text
Lobby A -> lobby.closed -> local Table tabs
Lobby A closes all background subscriptions
Lobby A drops all route and tensor state
```

Existing direct Table-to-Table edges remain connected, but future lobby-tunnelled discovery is unavailable until a new Lobby tab starts.

## Hebbian routing rules

- Only `LobbyP2PSession` may instantiate `NeuralNode`.
- Only Lobby-owned P2P edges feed neighbour confirmations and tensor learning.
- Table direct edges do not update the tensor.
- A table may notify its Lobby that a direct edge exists, but the Lobby may only update its in-memory route registry, not learn a Hebbian route from it.
- Table tabs must not emit beacons, reminders, or feedback.

## Public bootstrap file

Add one optional browser entry file, for example:

```text
privatepoker-p2p/public/privatepoker-p2p.js
```

It may only:

- Import or inline the library session classes.
- Read simple bootstrap configuration from `window.privatepokerP2P` or `data-*` attributes.
- Construct `BrowserTabBus`.
- Start `LobbyP2PSession` or `TableP2PSession`.

It must not:

- Implement protocol rules.
- Store configuration.
- Persist state.
- Contain poker logic.

Apps using a bundler should import the library directly and do not need this file.

## Implementation milestones

### Milestone 1 — Tab bus and message contracts

- Add `BrowserTabBus`.
- Add `TabMessage`.
- Add unit tests for publish/receive/close.
- Add a static guard test that rejects forbidden browser-storage APIs.
- Keep `VirtualControlBus` for WebRTC control messages, but rename or narrow it if that clarifies the boundary.

### Milestone 2 — Split Lobby and Table network hosts

- Add a role-aware host factory.
- `role: 'lobby'` creates `NeuralRoutingNetwork`.
- `role: 'table'` creates no neural overlay.
- Remove the public `routeOracle` concept.
- Keep mesh access inside the Lobby host.

### Milestone 3 — Move Lobby orchestration into the library

- Rework `LobbyRouteKeeper` into `BackgroundConnectionKeeper`.
- Add `FindPeerService`.
- Add `TableTunnelServer`.
- Add `LobbyP2PSession`.
- Remove testapp-specific route-probe and keep-route logic from application code.

### Milestone 4 — Move Table orchestration into the library

- Add `TableP2PSession`.
- Add `LobbySignallingClient`.
- Add `ConnectionDirection`.
- Make `subscribe()` perform the entire Lobby-first flow internally.
- Ensure table close only destroys table state.

### Milestone 5 — Mesh fallback ownership

- Wire mesh fallback into `FindPeerService`.
- Ensure gossip is tried before mesh.
- Ensure only the Lobby performs fallback while a Lobby tab is alive.
- Add explicit logs for:
  - `lobby.find.gossip`
  - `lobby.find.mesh-fallback`
  - `lobby.find.route-ready`
  - `lobby.find.route-failed`

### Milestone 6 — Testapp integration

- Replace `main.jsx` orchestration with:
  - `LobbyP2PSession`
  - `TableP2PSession`
- Keep only:
  - URL parsing
  - UI rendering
  - event display
  - waiting prompt rendering
- Remove `TableRoutePublisher`, `TestRoutes`, and manual route probing from the testapp.
- Add the optional public bootstrap file if desired.

### Milestone 7 — Verification

- Run all library unit tests.
- Run all testapp unit tests.
- Run the two-browser lifecycle harness.
- Run the waiting-prompt regression harness.
- Add a fresh-table/no-lobby-route regression case that proves the first connection uses the Lobby path and only falls back to mesh after gossip fails.
- Add a close-table-tab case that proves the Lobby edge remains connected.
- Add a reopen-table-tab case that proves the second table reuses the live Lobby edge.
- Add a static grep/test guard proving no browser storage is used.

## Acceptance criteria

1. A fresh Table tab asks its Lobby tab over `BroadcastChannel`.
2. The Lobby tab performs gossip first and mesh fallback second.
3. The Table tab never runs Hebbian routing.
4. Once the Lobby edge is live, the Table tab tunnels its own signalling through that edge.
5. The direct Table-to-Table edge is explicitly scoped and does not replace the Lobby background edge.
6. Closing a Table tab closes only the direct edge and destroys only table state.
7. The Lobby background edge remains connected.
8. Reopening a Table tab reuses the Lobby edge.
9. Closing a Lobby tab destroys all Lobby state and background edges.
10. No browser storage exists anywhere in `privatepoker-p2p` or `privatepoker-p2p-testapp`.
11. `privatepoker-p2p-testapp/src/main.jsx` contains UI wiring only.
12. All unit tests and two-browser harnesses pass.
