import { ConnectionStep } from '../events/ConnectionStep.js';

function haarStrided(arr, start, length, stride) {
  const half = length / 2;
  const temp = new Float32Array(length);

  // 1. Forward pass with stride
  for (let i = 0; i < half; i++) {
    const a = arr[start + (2 * i) * stride];
    const b = arr[start + (2 * i + 1) * stride];
    temp[i] = (a + b) / Math.SQRT2;
    temp[half + i] = (a - b) / Math.SQRT2;
  }

  // 2. Write back with stride
  for (let i = 0; i < length; i++) {
    arr[start + i * stride] = temp[i];
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
    this.tensors = new Map(); // cache key -> { tensor, N }
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
    const addressKey = this.network.address.toString();
    const cacheKey = `${addressKey}:${N}`;

    if (!this.tensors.has(cacheKey)) {
      const tensor = new Float32Array(size);
      for (let i = 0; i < size; i++) {
        tensor[i] = Math.random() * 0.3 + 0.1;
      }
      this.transformTensor(tensor, N);
      this.tensors.set(cacheKey, tensor);
    }
    return { tensor: this.tensors.get(cacheKey), N };
  }

  transformTensor(tensor, N) {
    const T_stride = this.D;
    const N_stride = this.T * this.D;
    const E_stride = N * this.T * this.D;

    // 1. Transform across Time Depth (D) - stride = 1
    for (let e = 0; e < this.E; e++) {
      for (let n = 0; n < N; n++) {
        for (let t = 0; t < this.T; t++) {
          const base = e * E_stride + n * N_stride + t * T_stride;
          haarStrided(tensor, base, this.D, 1);
        }
      }
    }

    // 2. Transform across Targets (T) - stride = D
    for (let e = 0; e < this.E; e++) {
      for (let n = 0; n < N; n++) {
        for (let d = 0; d < this.D; d++) {
          const base = e * E_stride + n * N_stride + d;
          haarStrided(tensor, base, this.T, T_stride);
        }
      }
    }
  }

  gossipUpdate(incomingSlice, alpha = 0.75) {
    const addressKey = this.network.address.toString();
    for (const [cacheKey, localTensor] of this.tensors.entries()) {
      if (!cacheKey.startsWith(`${addressKey}:`)) continue;
      const limit = Math.min(localTensor.length, incomingSlice.length);
      for (let i = 0; i < limit; i++) {
        localTensor[i] = alpha * localTensor[i] + (1 - alpha) * incomingSlice[i];
        if (Math.abs(localTensor[i]) < 0.03) {
          localTensor[i] = 0.01; // Soft thresholding / noise suppression
        }
      }
    }
  }

  // Hebbian Reinforcement: Called when a connection attempt succeeds
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
    const addressKey = this.network.address.toString();
    let tensor = null;
    for (const [cacheKey, t] of this.tensors.entries()) {
      if (cacheKey.startsWith(`${addressKey}:`)) {
        tensor = t;
        break;
      }
    }
    if (!tensor) return;

    const compressedSummary = Array.from(tensor).filter((val) => Math.abs(val) > 0.05);

    this.network.broadcastControl({
      type: 'neural-haar-gossip',
      from: addressKey,
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

    this.network.broadcastControl({
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