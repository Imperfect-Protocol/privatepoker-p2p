import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LobbyP2PSession } from './LobbyP2PSession.js';
import { TableP2PSession } from './TableP2PSession.js';

const ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function runtime() {
  return {
    BroadcastChannel: class {
      close() {}
    },
    RTCPeerConnection: null,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    crypto: globalThis.crypto,
  };
}

test('every Lobby receives a fresh random parent id', () => {
  const first = new LobbyP2PSession({ address: ADDRESS, privateKey: {}, runtime: runtime() });
  const second = new LobbyP2PSession({ address: ADDRESS, privateKey: {}, runtime: runtime() });

  assert.notEqual(first.peerId, second.peerId);
  assert.notEqual(first.host.config.peerId, second.host.config.peerId);
  first.close();
  second.close();
});

test('two Lobbies for the same address do not match each other', () => {
  const first = new LobbyP2PSession({ address: ADDRESS, privateKey: {}, peerId: 'parent-a', runtime: runtime() });
  const second = new LobbyP2PSession({ address: ADDRESS, privateKey: {}, peerId: 'parent-b', runtime: runtime() });
  assert.notEqual(first.peerId, second.peerId);
  assert.equal(first.peerId, first.host.config.peerId);
  assert.equal(second.peerId, second.host.config.peerId);
  first.close();
  second.close();
});

test('a Table tab requires and preserves its parent Lobby id', () => {
  const session = new TableP2PSession({
    address: ADDRESS,
    privateKey: {},
    peerId: 'parent-a',
    runtime: runtime(),
  });
  assert.equal(session.peerId, session.host.config.peerId);
  assert.throws(() => new TableP2PSession({ address: ADDRESS, privateKey: {}, runtime: runtime() }), /peerId/);
  session.close();
});
