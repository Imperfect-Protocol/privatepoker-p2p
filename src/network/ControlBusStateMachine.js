import { ControlBusState } from './ControlBusState.js';

export class ControlBusStateMachine {
  constructor() {
    this.state = ControlBusState.INITIAL;
  }

  workerConnecting() {
    if (this.state === ControlBusState.CLOSED) return false;
    this.state = ControlBusState.WORKER_CONNECTING;
    return true;
  }

  workerReady() {
    if (this.state === ControlBusState.CLOSED) return false;
    this.state = ControlBusState.WORKER_READY;
    return true;
  }

  workerUnavailable() {
    if (this.state === ControlBusState.CLOSED) return false;
    this.state = ControlBusState.BROADCAST_FALLBACK;
    return true;
  }

  close() {
    this.state = ControlBusState.CLOSED;
    return true;
  }

  usesWorker() {
    return (
      this.state === ControlBusState.WORKER_CONNECTING
      || this.state === ControlBusState.WORKER_READY
    );
  }

  canPostWorker() {
    return this.state === ControlBusState.WORKER_READY;
  }

  acceptsBroadcast() {
    return (
      this.state === ControlBusState.INITIAL
      || this.state === ControlBusState.BROADCAST_FALLBACK
    );
  }
}
