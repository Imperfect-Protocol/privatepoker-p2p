import { WebRtcEnvelope } from './WebRtcEnvelope.js';

export class WebRtcPeerSession {
  constructor(fields) {
    this.localAddress = fields.localAddress;
    this.peerAddress = fields.peerAddress;
    this.rtcConfig = fields.rtcConfig;
    this.RTCPeerConnection = fields.RTCPeerConnection;
    this.peerConnection = null;
    this.dataChannel = null;
    this.onConnected = null;
    this.onDisconnected = null;
    this.onMessage = null;
    this.onControl = null;
    this.onMediaStream = null;
    this.runtime = fields.runtime;
    this.iceGatheringTimeoutMs = fields.iceGatheringTimeoutMs;
    this.media = new WebRtcMediaNegotiator(this);
  }

  isConnected() {
    return this.dataChannel?.readyState === 'open';
  }

  createPeerConnection(createChannel) {
    this.peerConnection = new this.RTCPeerConnection(this.rtcConfig);
    this.peerConnection.onconnectionstatechange = () => this.handlePeerState();
    this.peerConnection.ondatachannel = (event) => this.attachDataChannel(event.channel);
    this.peerConnection.ontrack = (event) => this.media.handleTrack(event);
    if (createChannel) this.attachDataChannel(this.peerConnection.createDataChannel('virtual-network'));
    return this.peerConnection;
  }

  async createOffer() {
    this.createPeerConnection(true);
    await this.peerConnection.setLocalDescription(await this.peerConnection.createOffer());
    await this.waitForIce();
    return this.peerConnection.localDescription;
  }

  async acceptOffer(offer) {
    this.createPeerConnection(false);
    await this.peerConnection.setRemoteDescription(offer);
    await this.peerConnection.setLocalDescription(await this.peerConnection.createAnswer());
    await this.waitForIce();
    return this.peerConnection.localDescription;
  }

  async applyAnswer(answer) {
    await this.peerConnection.setRemoteDescription(answer);
  }

  attachDataChannel(dataChannel) {
    this.dataChannel = dataChannel;
    this.dataChannel.onopen = () => {
      this.media.sync();
      this.onConnected?.();
    };
    this.dataChannel.onclose = () => this.onDisconnected?.();
    this.dataChannel.onmessage = (event) => this.handleDataMessage(event);
  }

  setLocalStream(stream) {
    this.media.setLocalStream(stream);
  }

  sendMessage(channelLabel, messageData) {
    this.dataChannel.send(JSON.stringify(WebRtcEnvelope.message(channelLabel, messageData)));
  }

  sendControl(messageData) {
    this.dataChannel.send(JSON.stringify(WebRtcEnvelope.control(messageData)));
  }

  sendMedia(description) {
    this.dataChannel.send(JSON.stringify(WebRtcEnvelope.media({ type: description.type, sdp: description.sdp })));
  }

  handleDataMessage(event) {
    const envelope = JSON.parse(event.data);
    if (envelope.kind === 'control') {
      this.onControl?.(envelope.messageData);
      return;
    }
    if (envelope.kind === 'media') {
      this.media.handleDescription(envelope.messageData);
      return;
    }
    this.onMessage?.(envelope);
  }

  handlePeerState() {
    if (['closed', 'failed', 'disconnected'].includes(this.peerConnection?.connectionState)) {
      this.onDisconnected?.();
    }
  }

  waitForIce() {
    if (this.peerConnection.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        this.peerConnection.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      };
      const onChange = () => {
        if (this.peerConnection.iceGatheringState === 'complete') finish();
      };
      this.peerConnection.addEventListener('icegatheringstatechange', onChange);
      this.runtime.setTimer(finish, this.iceGatheringTimeoutMs);
    });
  }

  close() {
    this.dataChannel?.close();
    this.peerConnection?.close();
  }
}

/**
 * Audio/video on the session's own RTCPeerConnection. Renegotiation offers and answers travel
 * over the open data channel ("perfect negotiation": the higher address is the polite peer).
 */
class WebRtcMediaNegotiator {
  constructor(session) {
    this.session = session;
    this.localStream = null;
    this.senders = new Map();
    this.queue = Promise.resolve();
    this.makingOffer = false;
    this.pendingOffer = false;
    this.polite = String(session.localAddress) > String(session.peerAddress);
  }

  setLocalStream(stream) {
    this.localStream = stream;
    this.sync();
  }

  sync() {
    const pc = this.session.peerConnection;
    if (!pc || !this.session.isConnected()) return;
    const tracks = this.localStream?.getTracks() ?? [];
    const trackIds = new Set(tracks.map((track) => track.id));
    let changed = false;

    this.senders.forEach((sender, trackId) => {
      if (trackIds.has(trackId)) return;
      pc.removeTrack(sender);
      this.senders.delete(trackId);
      changed = true;
    });
    tracks.forEach((track) => {
      if (this.senders.has(track.id)) return;
      this.senders.set(track.id, pc.addTrack(track, this.localStream));
      changed = true;
    });

    if (changed) {
      this.pendingOffer = true;
      this.enqueue(() => this.offer());
    }
  }

  enqueue(task) {
    this.queue = this.queue.then(task).catch((error) => console.error('[privatepoker-p2p] media negotiation failed', error));
  }

  async offer() {
    const pc = this.session.peerConnection;
    if (!this.pendingOffer || !pc || !this.session.isConnected() || pc.signalingState !== 'stable') return;
    this.pendingOffer = false;
    this.makingOffer = true;
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await this.session.waitForIce();
      this.session.sendMedia(pc.localDescription);
    } finally {
      this.makingOffer = false;
    }
  }

  handleDescription(description) {
    this.enqueue(async () => {
      const pc = this.session.peerConnection;
      if (!pc) return;
      if (description.type === 'answer') {
        if (pc.signalingState === 'have-local-offer') await pc.setRemoteDescription(description);
        if (this.pendingOffer) this.enqueue(() => this.offer());
        return;
      }

      const collision = this.makingOffer || pc.signalingState !== 'stable';
      if (collision && !this.polite) return;
      if (collision) await pc.setLocalDescription({ type: 'rollback' });
      await pc.setRemoteDescription(description);
      this.pendingOffer = false;
      await pc.setLocalDescription(await pc.createAnswer());
      await this.session.waitForIce();
      this.session.sendMedia(pc.localDescription);
      if (this.pendingOffer) this.enqueue(() => this.offer());
    });
  }

  handleTrack(event) {
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    const publish = () => this.session.onMediaStream?.(stream);
    stream.onaddtrack = publish;
    stream.onremovetrack = publish;
    event.track.onunmute = publish;
    event.track.onmute = publish;
    event.track.onended = publish;
    publish();
  }
}
