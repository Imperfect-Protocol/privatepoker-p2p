import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebRtcPeerSession } from './WebRtcPeerSession.js';

class FakePeerConnection {
  constructor() {
    this.signalingState = 'stable';
    this.iceGatheringState = 'complete';
    this.senders = [];
    this.descriptions = [];
  }
  createDataChannel() {
    return { readyState: 'open', messages: [], send(value) { this.messages.push(JSON.parse(value)); }, close() {} };
  }
  async createOffer() { return { type: 'offer', sdp: 'offer-sdp' }; }
  async createAnswer() { return { type: 'answer', sdp: 'answer-sdp' }; }
  async setLocalDescription(description) {
    this.descriptions.push(description.type);
    this.localDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(description) {
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  addTrack(track, stream) { const sender = { track, stream }; this.senders.push(sender); return sender; }
  removeTrack(sender) { this.senders = this.senders.filter((entry) => entry !== sender); }
  close() {}
}

function session(localAddress = 'a', peerAddress = 'b') {
  const peer = new WebRtcPeerSession({ localAddress, peerAddress, RTCPeerConnection: FakePeerConnection, rtcConfig: {}, runtime: { setTimer: setTimeout }, iceGatheringTimeoutMs: 10 });
  peer.createPeerConnection(true);
  return peer;
}

function stream(...tracks) { return { getTracks: () => tracks }; }

function mediaStream(...tracks) {
  const members = [...tracks];
  return {
    id: 'stable-outbound-stream',
    getTracks: () => [...members],
    addTrack: (track) => members.push(track),
    removeTrack: (track) => {
      const index = members.indexOf(track);
      if (index >= 0) members.splice(index, 1);
    },
  };
}

async function flush(peer) {
  await peer.media.queue;
  await peer.media.queue;
}

test('media uses the existing connection and removes tracks without closing data', async () => {
  const peer = session();
  const connection = peer.peerConnection;
  const audio = { id: 'audio', kind: 'audio' };
  const video = { id: 'video', kind: 'video' };
  peer.setLocalStream(stream(audio, video));
  await flush(peer);
  assert.equal(peer.peerConnection, connection);
  assert.equal(connection.senders.length, 2);
  assert.equal(peer.dataChannel.messages[0].kind, 'media');
  peer.media.handleDescription({ type: 'answer', sdp: 'answer' });
  await flush(peer);
  peer.setLocalStream(stream(audio));
  await flush(peer);
  assert.equal(connection.senders.length, 1);
  assert.equal(connection.senders[0].track.kind, 'audio');
  assert.equal(peer.isConnected(), true);
});

test('audio and video keep one outbound stream when devices are enabled separately', async () => {
  const peer = session();
  const connection = peer.peerConnection;
  const video = { id: 'video', kind: 'video' };
  const audio = { id: 'audio', kind: 'audio' };

  peer.setLocalStream(mediaStream(video));
  await flush(peer);
  peer.media.handleDescription({ type: 'answer', sdp: 'answer' });
  await flush(peer);

  peer.setLocalStream(mediaStream(video, audio));
  await flush(peer);

  assert.equal(connection.senders.length, 2);
  assert.equal(connection.senders[0].stream, connection.senders[1].stream);
  assert.deepEqual(connection.senders[0].stream.getTracks().map((track) => track.id), ['video', 'audio']);
});

test('track changes during an outstanding offer trigger a second offer after its answer', async () => {
  const peer = session();
  peer.setLocalStream(stream({ id: 'audio' }));
  await flush(peer);
  peer.setLocalStream(stream({ id: 'audio' }, { id: 'video' }));
  await flush(peer);
  assert.equal(peer.dataChannel.messages.length, 1);
  peer.media.handleDescription({ type: 'answer', sdp: 'answer' });
  await flush(peer);
  assert.equal(peer.dataChannel.messages.length, 2);
});

test('simultaneous offers: polite peer rolls back, impolite peer ignores collision', async () => {
  const polite = session('b', 'a');
  const impolite = session('a', 'b');
  for (const peer of [polite, impolite]) {
    peer.setLocalStream(stream({ id: 'audio' }));
    await flush(peer);
    peer.media.handleDescription({ type: 'offer', sdp: 'remote' });
    await flush(peer);
  }
  assert.ok(polite.peerConnection.descriptions.includes('rollback'));
  assert.equal(polite.dataChannel.messages.at(-1).messageData.type, 'answer');
  assert.equal(impolite.peerConnection.signalingState, 'have-local-offer');
  assert.equal(impolite.peerConnection.descriptions.includes('rollback'), false);
});

test('media descriptions are consumed internally; application messages still arrive', async () => {
  const peer = session();
  const received = [];
  peer.onMessage = (message) => received.push(message);
  peer.handleDataMessage({ data: JSON.stringify({ kind: 'media', messageData: { type: 'offer', sdp: 'remote' } }) });
  await flush(peer);
  assert.equal(received.length, 0);
  peer.handleDataMessage({ data: JSON.stringify({ kind: 'message', messageData: { kind: 'chat', text: 'hello' } }) });
  assert.equal(received[0].messageData.text, 'hello');
});

test('local offer tracks whether this session can consume an answer', async () => {
  const offerer = session();
  assert.equal(offerer.hasLocalOffer(), false);
  await offerer.createOffer();
  assert.equal(offerer.hasLocalOffer(), true);
  await offerer.applyAnswer({ type: 'answer', sdp: 'answer' });
  assert.equal(offerer.hasLocalOffer(), false);

  const answerer = session();
  await answerer.acceptOffer({ type: 'offer', sdp: 'remote' });
  assert.equal(answerer.hasLocalOffer(), false);
});
