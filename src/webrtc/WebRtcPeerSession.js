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
    this.runtime = fields.runtime;
    this.iceGatheringTimeoutMs = fields.iceGatheringTimeoutMs;
  }

  isConnected() {
    return this.dataChannel?.readyState === 'open';
  }

  createPeerConnection(createChannel) {
    this.peerConnection = new this.RTCPeerConnection(this.rtcConfig);
    this.peerConnection.onconnectionstatechange = () => this.handlePeerState();
    this.peerConnection.ondatachannel = (event) => this.attachDataChannel(event.channel);
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
    this.dataChannel.onopen = () => this.onConnected?.();
    this.dataChannel.onclose = () => this.onDisconnected?.();
    this.dataChannel.onmessage = (event) => this.handleDataMessage(event);
  }

  sendMessage(channelLabel, messageData) {
    this.dataChannel.send(JSON.stringify(WebRtcEnvelope.message(channelLabel, messageData)));
  }

  sendControl(messageData) {
    this.dataChannel.send(JSON.stringify(WebRtcEnvelope.control(messageData)));
  }

  handleDataMessage(event) {
    const envelope = JSON.parse(event.data);
    if (envelope.kind === 'control') {
      this.onControl?.(envelope.messageData);
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
