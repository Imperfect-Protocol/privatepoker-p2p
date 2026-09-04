import { VirtualNetworkConfig } from '../config/VirtualNetworkConfig.js';
import { VirtualNetworkRuntime } from './VirtualNetworkRuntime.js';
import { VirtualNetworkHost } from './VirtualNetworkHost.js';

export class VirtualNetwork {
  #host;

  constructor(handlerFunction, address, privateKey, config = new VirtualNetworkConfig(), runtime = new VirtualNetworkRuntime()) {
    this.#host = new VirtualNetworkHost(handlerFunction, address, privateKey, config, runtime);
  }

  subscribe(subscriptionLabel, channelLabel, peerAddress, timeout, lobbyId = undefined, tableId = undefined) {
    return this.#host.subscribe(subscriptionLabel, channelLabel, peerAddress, timeout, lobbyId, tableId);
  }

  unsubscribe(subscriptionLabel) {
    return this.#host.unsubscribe(subscriptionLabel);
  }

  send(channelLabel, message) {
    return this.#host.send(channelLabel, message);
  }
}
