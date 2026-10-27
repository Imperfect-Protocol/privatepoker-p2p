import { ConnectionStep } from '../events/ConnectionStep.js';

function haar1D(arr, start, length) {
  const half = length / 2;
  const temp = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    const a = arr[start + 2 * i];
    const b = arr[start + 2 * i + 1];
    temp[i] = (a + b) / Math.SQRT2;
    temp[half + i] = (a - b) / Math.SQRT2;
  }
  for (let i = 0; i < length; i++) {
    arr[start + i] = temp[i];
  }
}

export class NeuralHaarRoutingNetwork {
  constructor(network, config = {}) {
    this.network = network;
    this.E = config.E ?? 4; 
    this.T = config.T ?? 16; 
    this.D = config.D ?? 4; 
    this.gossipIntervalMs = config.gossipIntervalMs ?? 5_000;
    this.timer = null;
    this.tensors = new Map(); // local key -> tensor
  }

  start() {
    this.startGossipLoop();
  }

  stop() {
    if (this.timer) {
      this.network.runtime.clearTimer(this.timer);
      this.timer = null;
    }
  }

  getTensorState(neighbors) {
    const N = Math.max(2, neighbors.length);
    const size = this.E * N * this.T * this.D;
    const key = this.network.address.toString();
    
    if (!this.tensors.has(key)) {
      const tensor = new Float32Array(size);
      for (let i = 0; i < size; i++) {
        tensor[i] = Math.random() * 0.3 + 0.1;
      }
      // Apply initial multi-axis Haar transform across Time Depth and Targets
      this.transformTensor(tensor, N);
      this.tensors.set(key, tensor);
    }
    return { tensor: this.tensors.get(key), N };
  }

  transformTensor(tensor, N) {
    // 1. Transform across Time Depth (D)
    for (let e = 0; e < this.E; e++) {
      for (let n = 0; n < N; n++) {
        for (let t = 0; t < this.T; t++) {
          const base = e * (N * this.T * this.D) + n * (this.T * this.D) + t * this.D;
          haar1D(tensor, base, this.D);
        }
      }
    }
  }

  gossipUpdate(incomingSlice, alpha = 0.75) {
    const key = this.network.address.toString();
    const localTensor = this.tensors.get(key);
    if (!localTensor) return;

    const limit = Math.min(localTensor.length, incomingSlice.length);
    for (let i = 0; i < limit; i++) {
      localTensor[i] = alpha * localTensor[i] + (1 - alpha) * incomingSlice[i];
      if (Math.abs(localTensor[i]) < 0.03) {
        localTensor[i] = 0.01; // Soft thresholding / noise suppression
      }
    }
  }

  reinforceSuccess(targetAddress, neighbors, reward = 3.5, alpha = 0.7) {
    const { tensor, N } = this.getTensorState(neighbors);
    const targetIdx = Math.abs(this.hashCode(targetAddress)) % this.T;

    for (let e = 0; e < this.E; e++) {
      for (let n = 0; n < N; n++) {
        for (let d = 0; d < this.D; d++) {
          const idx = e * (N * this.T * this.D) +
                     n * (this.T * this.D) +
                     targetIdx * this.D +
                     d;
          tensor[idx] = alpha * tensor[idx] + (1 - alpha) * reward;
        }
      }
    }
  }

  startGossipLoop() {
    if (this.timer) return;
    this.timer = this.network.runtime.setTimer(() => {
      this.timer = null;
      this.broadcastGossip();
      this.startGossipLoop();
    }, this.gossipIntervalMs);
  }

  broadcastGossip() {
    const key = this.network.address.toString();
    const tensor = this.tensors.get(key);
    if (!tensor) return;

    // Sparse compression: send non-significant wavelet coefficients
    const compressedSummary = Array.from(tensor).filter((val) => Math.abs(val) > 0.05);

    this.network.broadcastControl({
      type: 'neural-haar-gossip',
      from: key,
      tensorSlice: compressedSummary,
    });
  }

  selectNextHop(targetAddress, neighbors) {
    if (!neighbors || neighbors.length === 0) return null;
    const { tensor, N } = this.getTensorState(neighbors);
    const targetIdx = Math.abs(this.hashCode(targetAddress)) % this.T;

    let bestNeighbor = neighbors[0];
    let maxScore = -Infinity;

    for (let n = 0; n < Math.min(neighbors.length, N); n++) {
      let score = 0;
      for (let e = 0; e < this.E; e++) {
        for (let d = 0; d < this.D; d++) {
          const idx = e * (N * this.T * this.D) +
                     n * (this.T * this.D) +
                     targetIdx * this.D +
                     d;
          score += tensor[idx] ?? 0;
        }
      }
      const stochasticScore = score * (Math.random() * 0.3 + 0.85);
      if (stochasticScore > maxScore) {
        maxScore = stochasticScore;
        bestNeighbor = neighbors[n];
      }
    }
    return bestNeighbor;
  }

  async findPeer(subscription) {
    this.network.emitConnectionStep({
      step: ConnectionStep.ANNOUNCE_SENT,
      via: 'neural-haar',
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
      peerAddress: subscription.peerAddress.toString(),
    });

    const neighbors = this.network.getConnectedPeers?.() || [];
    const nextHop = this.selectNextHop(subscription.peerAddress.toString(), neighbors);

    this.network.sendControl({
      type: 'neural-haar-announce',
      from: this.network.address.toString(),
      to: subscription.peerAddress.toString(),
      nextHop: nextHop?.toString(),
      senderRole: this.network.config.role,
      targetRole: this.network.config.role,
      initiatorInstanceId: this.network.instanceId,
      subscriptionLabel: subscription.subscriptionLabel,
      channelLabel: subscription.channelLabel,
      lobbyId: subscription.lobbyId,
      tableId: subscription.tableId,
    });
  }

  hashCode(str) {
    let hash = 0;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash) + s.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }
}