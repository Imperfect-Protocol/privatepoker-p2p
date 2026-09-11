import { Address } from '../core/Address.js';

export class SubscriptionScope {
  constructor(fields = {}) {
    this.subscriptionLabel = fields.subscriptionLabel;
    this.channelLabel = fields.channelLabel;
    this.peerAddress = Address.from(fields.peerAddress).toString();
    this.lobbyId = String(fields.lobbyId);
    this.tableId = String(fields.tableId);
  }

  static from(fields = {}) {
    return new SubscriptionScope(fields);
  }

  subscriptionKey() {
    return [
      this.subscriptionLabel,
      this.peerAddress,
      this.lobbyId,
      this.tableId,
    ].join(':');
  }

  channelKey() {
    return [
      this.channelLabel,
      this.peerAddress,
      this.lobbyId,
      this.tableId,
    ].join(':');
  }

  matches(subscription) {
    return (
      subscription.subscriptionLabel === this.subscriptionLabel
      && subscription.channelLabel === this.channelLabel
      && subscription.peerAddress.toString() === this.peerAddress
      && subscription.lobbyId === this.lobbyId
      && subscription.tableId === this.tableId
    );
  }
}
