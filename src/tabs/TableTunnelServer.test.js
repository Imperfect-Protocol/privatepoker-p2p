import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TableTunnelServer } from './TableTunnelServer.js';

const PEER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const announce = {
  id: 'announce-1',
  type: 'p2p-mst-announce',
  from: PEER,
  to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  senderRole: 'table',
  targetRole: 'table',
  initiatorInstanceId: 'remote-table',
  subscriptionLabel: 'inbound',
  channelLabel: 'outbound',
  lobbyId: '1',
  tableId: '16',
};

function makeNetwork() {
  const timers = new Map();
  const waits = [];
  const events = [];
  let nextTimer = 0;
  return {
    waits,
    events,
    timers,
    runtime: {
      setTimer: (callback) => {
        nextTimer += 1;
        timers.set(nextTimer, callback);
        return nextTimer;
      },
      clearTimer: (timer) => timers.delete(timer),
    },
    emitReceivedSignal() {},
    sendControlLocally() {},
    respondPeerWaitingWhenLobbyRouteFound: (message) => waits.push(message),
    handler: (event) => events.push(event),
  };
}

test('an unacknowledged table announce creates a wait, which ends on table connection', () => {
  const network = makeNetwork();
  const tunnel = new TableTunnelServer(network, 250);

  tunnel.deliver(announce);
  network.timers.forEach((fire) => fire());
  assert.equal(network.waits.length, 1);
  assert.equal(network.events.length, 0);

  tunnel.connected({
    type: 'table-connection-ready',
    peerAddress: PEER,
    lobbyId: '1',
    tableId: '16',
  });

  assert.equal(network.events.length, 1);
  assert.equal(network.events[0].type, 'PeerWaitAccepted');
  assert.equal(network.events[0].requestId, 'announce-1');
  assert.equal(network.events[0].tableId, '16');
});

test('a table announce acknowledgement prevents a stale waiting prompt', () => {
  const network = makeNetwork();
  const tunnel = new TableTunnelServer(network, 250);

  tunnel.deliver(announce);
  tunnel.acknowledge({ requestId: announce.id });

  assert.equal(network.timers.size, 0);
  assert.equal(network.waits.length, 0);

  tunnel.connected({ peerAddress: PEER, lobbyId: '1', tableId: '16' });
  assert.equal(network.events.length, 0);
});

test('closing the tunnel drops all pending in-memory timers and waits', () => {
  const network = makeNetwork();
  const tunnel = new TableTunnelServer(network, 250);
  tunnel.deliver(announce);

  tunnel.close();

  assert.equal(network.timers.size, 0);
  assert.equal(tunnel.waiting.size, 0);
});
