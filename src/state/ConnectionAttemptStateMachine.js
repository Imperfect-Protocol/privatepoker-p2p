import { ConnectionState } from './ConnectionState.js';

export class ConnectionAttemptStateMachine {
  constructor(subscription, runtime) {
    this.subscription = subscription;
    this.runtime = runtime;
    this.state = ConnectionState.INITIAL;
    this.timer = null;
  }

  start() {
    this.clearTimer();
    this.transition(this.subscription.shouldTryMeshNodeFirst()
      ? ConnectionState.TRY_MESH_NODE
      : ConnectionState.TRY_P2P_NETWORK);
    this.armTimeout();
  }

  connected() {
    this.clearTimer();
    this.transition(ConnectionState.PEER_CONNECTED);
  }

  timedOut() {
    const timedOutState = this.state;
    this.clearTimer();
    this.subscription.rememberTimeout(timedOutState);
    this.transition(ConnectionState.CONNECTION_TIMEOUT);
    this.subscription.abortNegotiation();
    this.subscription.emitTimeout(timedOutState);
  }

  failed(error) {
    this.clearTimer();
    this.transition(ConnectionState.FAILED);
    this.subscription.emitFailure(error);
  }

  disconnected() {
    this.clearTimer();
    this.transition(ConnectionState.DISCONNECTED);
  }

  transition(state) {
    this.state = state;
    this.subscription.state = state;
  }

  armTimeout() {
    this.timer = this.runtime.setTimer(() => this.timedOut(), this.subscription.timeout.toMilliseconds());
  }

  clearTimer() {
    if (!this.timer) return;
    this.runtime.clearTimer(this.timer);
    this.timer = null;
  }
}
