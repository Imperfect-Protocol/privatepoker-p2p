import { VirtualNetworkConsoleLogger } from '../logging/VirtualNetworkConsoleLogger.js';
import { ControlBusStateMachine } from './ControlBusStateMachine.js';

class ControlBusMessage {
  static ready = 'READY';

  static heartbeat = 'HEARTBEAT';

  static registerSession = 'REGISTER_SESSION';

  static unregisterSession = 'UNREGISTER_SESSION';

  static controlMessage = 'CONTROL_MESSAGE';

  static controlRouteResult = 'CONTROL_ROUTE_RESULT';
}

class ControlBusSession {
  constructor(host, subscription) {
    this.address = host.address.toString();
    this.instanceId = host.instanceId;
    this.role = host.config.role;
    this.lobbyId = subscription.lobbyId;
    this.tableId = subscription.tableId;
    this.subscriptionLabel = subscription.subscriptionLabel;
  }

  key() {
    return [
      this.subscriptionLabel,
      this.role,
      this.address,
      this.lobbyId,
      this.tableId,
    ].join(':');
  }

  static presence(host, fields = {}) {
    const session = new ControlBusSession(host, {
      lobbyId: fields.lobbyId ?? host.config.lobbyId,
      tableId: fields.tableId ?? host.config.tableId,
      subscriptionLabel: fields.subscriptionLabel ?? 'presence',
    });
    session.presence = true;
    return session;
  }
}

export class VirtualControlBus {
  constructor(host) {
    this.host = host;
    this.broadcastChannel = null;
    this.worker = null;
    this.workerReady = false;
    this.workerHeartbeat = null;
    this.sessions = new Map();
    this.pendingControlMessages = [];
    this.stateMachine = new ControlBusStateMachine();
    this.openBroadcastChannel();
    this.openSharedWorker();
  }

  debug(label, detail = {}) {
    VirtualNetworkConsoleLogger.log(`control-bus.${label}`, {
      ...detail,
      address: this.host.address.toString(),
      instanceId: this.host.instanceId,
      role: this.host.config.role,
    });
  }

  openBroadcastChannel() {
    if (!this.host.runtime.BroadcastChannel) return;
    this.broadcastChannel = new this.host.runtime.BroadcastChannel(`${this.host.config.broadcastPrefix}:control`);
    this.broadcastChannel.onmessage = (event) => {
      if (!this.stateMachine.acceptsBroadcast()) return;
      this.host.handleControlMessage(event.data, 'broadcast');
    };
    this.debug('broadcast.ready');
  }

  openSharedWorker() {
    if (!this.host.runtime.SharedWorker) {
      this.stateMachine.workerUnavailable();
      return;
    }
    try {
      this.stateMachine.workerConnecting();
      this.worker = new this.host.runtime.SharedWorker(
        new URL('../workers/virtual-control-bus-worker.js', import.meta.url),
        { type: 'module' },
      );
      this.worker.port.onmessage = (event) => this.handleWorkerMessage(event.data);
      this.worker.port.start();
      this.debug('worker.connecting');
    } catch {
      this.worker = null;
      this.stateMachine.workerUnavailable();
      this.debug('worker.unavailable');
    }
  }

  handleWorkerMessage(message) {
    if (message?.type === ControlBusMessage.ready) {
      this.workerReady = true;
      this.stateMachine.workerReady();
      this.debug('worker.ready', { portId: message.portId });
      this.startWorkerHeartbeat();
      this.sessions.forEach((session) => this.postWorker({
        type: ControlBusMessage.registerSession,
        session,
      }));
      this.flushPendingControlMessages();
      return;
    }

    if (message?.type === ControlBusMessage.controlMessage) {
      this.debug('worker.recv', {
        messageType: message.message?.type,
        from: message.message?.from,
        to: message.message?.to,
        targetRole: message.message?.targetRole,
        tableId: message.message?.tableId,
        route: message.route,
      });
      this.host.handleControlMessage(message.message, message.route === 'direct' ? 'worker-direct' : 'worker-scatter');
      return;
    }

    if (message?.type === ControlBusMessage.controlRouteResult) {
      this.debug('worker.route-result', {
        messageType: message.message?.type,
        from: message.message?.from,
        to: message.message?.to,
        targetRole: message.message?.targetRole,
        tableId: message.message?.tableId,
        route: message.route,
        targetCount: message.targetCount,
      });
      this.host.handleControlRouteResult(message.message, message.route, message.targetCount);
    }
  }

  startWorkerHeartbeat() {
    if (this.workerHeartbeat || !this.worker) return;
    this.workerHeartbeat = this.host.runtime.setTimer(() => {
      this.postWorker({ type: ControlBusMessage.heartbeat });
      this.workerHeartbeat = null;
      this.startWorkerHeartbeat();
    }, 5_000);
  }

  register(subscription) {
    const session = new ControlBusSession(this.host, subscription);
    this.sessions.set(session.key(), session);
    this.debug('session.register', { session });
    this.postWorker({
      type: ControlBusMessage.registerSession,
      session,
    });
  }

  unregister(subscription) {
    const session = new ControlBusSession(this.host, subscription);
    this.sessions.delete(session.key());
    this.debug('session.unregister', { session });
    this.postWorker({
      type: ControlBusMessage.unregisterSession,
      session,
    });
  }

  registerPresence(fields = {}) {
    const session = ControlBusSession.presence(this.host, fields);
    this.sessions.set(session.key(), session);
    this.debug('presence.register', { session });
    this.postWorker({
      type: ControlBusMessage.registerSession,
      session,
    });
  }

  unregisterPresence(fields = {}) {
    const session = ControlBusSession.presence(this.host, fields);
    this.sessions.delete(session.key());
    this.debug('presence.unregister', { session });
    this.postWorker({
      type: ControlBusMessage.unregisterSession,
      session,
    });
  }

  post(message) {
    this.debug('post', {
      messageType: message.type,
      from: message.from,
      to: message.to,
      targetRole: message.targetRole,
      tableId: message.tableId,
    });
    if (this.stateMachine.usesWorker()) {
      this.postControlMessageToWorker(message);
      return;
    }
    this.postBroadcast(message);
  }

  postBroadcast(message) {
    this.broadcastChannel?.postMessage(message);
  }

  postWorker(message) {
    if (!this.worker || (!this.workerReady && message.type !== ControlBusMessage.heartbeat)) return false;
    this.worker.port.postMessage(message);
    return true;
  }

  postControlMessageToWorker(message) {
    const envelope = {
      type: ControlBusMessage.controlMessage,
      message,
      senderInstanceId: this.host.instanceId,
    };
    if (this.stateMachine.canPostWorker() && this.postWorker(envelope)) return;
    this.pendingControlMessages.push(envelope);
  }

  flushPendingControlMessages() {
    const messages = this.pendingControlMessages;
    this.pendingControlMessages = [];
    messages.forEach((message) => this.postWorker(message));
  }

  close() {
    if (this.workerHeartbeat) {
      this.host.runtime.clearTimer(this.workerHeartbeat);
      this.workerHeartbeat = null;
    }
    this.broadcastChannel?.close();
    this.worker?.port?.close?.();
    this.sessions.clear();
    this.pendingControlMessages = [];
    this.worker = null;
    this.broadcastChannel = null;
    this.workerReady = false;
    this.stateMachine.close();
  }
}
