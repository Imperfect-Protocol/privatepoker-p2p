import { VirtualNetworkConfig } from '../config/VirtualNetworkConfig.js';
import { VirtualNetworkHost } from '../network/VirtualNetworkHost.js';
import { VirtualNetworkRuntime } from '../network/VirtualNetworkRuntime.js';
import { VirtualNetworkConsoleLogger } from '../logging/VirtualNetworkConsoleLogger.js';
import { VirtualNetworkLogFormatter } from '../logging/VirtualNetworkLogFormatter.js';
import { RouteBus } from './RouteBus.js';
import { RouteLabels } from './RouteLabels.js';
import { RouteRecord } from './RouteRecord.js';
import { RouteStore } from './RouteStore.js';

export class LobbyRouteKeeper {
  constructor(handlerFunction, ownerAddress, privateKey, fields = {}) {
    this.handler = handlerFunction;
    this.ownerAddress = RouteRecord.address(ownerAddress);
    this.privateKey = privateKey;
    this.lobbyId = String(fields.lobbyId ?? '1');
    this.backgroundTableId = String(fields.backgroundTableId ?? '0');
    this.timeoutMs = Number(fields.timeoutMs ?? 10_000);
    this.meshUrls = fields.meshUrls ?? [];
    this.iceServers = fields.iceServers ?? [];
    this.broadcastPrefix = fields.broadcastPrefix ?? 'privatepoker-p2p';
    this.role = fields.role ?? 'lobby';
    this.logger = fields.logger ?? VirtualNetworkConsoleLogger;
    this.bus = fields.bus ?? new RouteBus({
      channelName: `${this.broadcastPrefix}:routes`,
      logger: this.logger,
    });
    this.store = fields.store ?? new RouteStore({
      storageKey: `${this.broadcastPrefix}:routes`,
      routeTtlMs: fields.routeTtlMs,
      liveRouteTtlMs: fields.liveRouteTtlMs,
    });
    this.pendingRoutes = new Map();
    this.activeLabels = new Map();
    this.liveRecords = new Map();
    this.reconnectTimers = new Map();
    this.liveHeartbeatTimer = null;
    this.host = null;
    this.presenceLabel = `lobby-presence:${this.ownerAddress}:${this.lobbyId}:${this.backgroundTableId}`;
    this.reconnectDelayMs = Number(fields.reconnectDelayMs ?? 1_000);
    this.liveHeartbeatMs = Number(fields.liveHeartbeatMs ?? 1_000);
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.bus.listen((message) => this.acceptRouteMessage(message));
    this.ensureHost();
    this.host.controlBus.registerPresence({
      lobbyId: this.lobbyId,
      tableId: this.backgroundTableId,
      subscriptionLabel: this.presenceLabel,
    });
  }

  stop() {
    this.activeLabels.forEach((record) => {
      this.store.markRecovering(record);
    });
    this.activeLabels.forEach((record) => {
      this.host?.unsubscribe(RouteLabels.subscription(record));
    });
    this.reconnectTimers.forEach((timer) => {
      this.host?.runtime.clearTimer(timer);
    });
    if (this.liveHeartbeatTimer) {
      this.host?.runtime.clearTimer(this.liveHeartbeatTimer);
      this.liveHeartbeatTimer = null;
    }
    this.host?.controlBus.unregisterPresence({ subscriptionLabel: this.presenceLabel });
    this.host?.controlBus.close();
    this.activeLabels.clear();
    this.liveRecords.clear();
    this.pendingRoutes.clear();
    this.reconnectTimers.clear();
    this.bus.close();
    this.host = null;
    this.started = false;
  }

  preserveRoute(fields = {}) {
    return this.bus.publishKeepRoute({
      ...fields,
      ownerAddress: fields.ownerAddress ?? this.ownerAddress,
      lobbyId: fields.lobbyId ?? this.lobbyId,
    });
  }

  knowsRoute(route) {
    if (!route?.peerAddress) return false;
    const pending = this.pendingRoutes.get(RouteRecord.address(route.peerAddress));
    if (pending) return true;
    return this.store.hasLivePeerRoute({
      ownerAddress: this.ownerAddress,
      peerAddress: route.peerAddress,
      lobbyId: route.lobbyId ?? this.lobbyId,
      backgroundTableId: this.backgroundTableId,
    });
  }

  acceptRouteMessage(message) {
    if (message?.type !== 'keep-route') return;
    const record = RouteRecord.from({
      ownerAddress: message.ownerAddress,
      peerAddress: message.peerAddress,
      lobbyId: message.lobbyId,
      tableId: message.tableId,
      backgroundTableId: this.backgroundTableId,
    });
    if (!record.owns(this.ownerAddress, this.lobbyId)) return;
    this.pendingRoutes.set(record.peerAddress, record);
    this.clearReconnect(record);
    this.emit({
      type: 'BackgroundRoute',
      step: 'PreserveRouteAccepted',
      ownerAddress: record.ownerAddress,
      peerAddress: record.peerAddress,
      lobbyId: record.lobbyId,
      tableId: record.tableId,
      backgroundTableId: record.backgroundTableId,
    });
    this.subscribe(record);
  }

  subscribe(record) {
    this.ensureHost();
    this.activeLabels.set(record.peerAddress, record);
    this.host.subscribe(
      RouteLabels.subscription(record),
      RouteLabels.channel(record),
      record.peerAddress,
      this.timeoutMs,
      record.lobbyId,
      record.backgroundTableId,
    );
  }

  ensureHost() {
    if (this.host) return this.host;
    this.host = new VirtualNetworkHost(
      (event) => this.handleNetworkEvent(event),
      this.ownerAddress,
      this.privateKey,
      new VirtualNetworkConfig({
        lobbyId: this.lobbyId,
        tableId: this.backgroundTableId,
        meshUrls: this.meshUrls,
        iceServers: this.iceServers,
        broadcastPrefix: this.broadcastPrefix,
        role: this.role,
        routeOracle: (route) => this.knowsRoute(route),
      }),
      new VirtualNetworkRuntime(),
    );
    return this.host;
  }

  handleNetworkEvent(event) {
    this.logger.log('lobby-route-keeper', {
      text: VirtualNetworkLogFormatter.text(this.ownerAddress, event),
      details: event,
    });
    if (event.type === 'PeerConnected') {
      this.rememberConnectedRoute(event);
    }
    if (event.type === 'PeerDisconnected' || event.type === 'ConnectionTimeout') {
      this.recoverRoute(event);
    }
    this.emit(event);
  }

  rememberConnectedRoute(event) {
    const record = this.pendingRoutes.get(RouteRecord.address(event.peerAddress))
      ?? this.activeLabels.get(RouteRecord.address(event.peerAddress));
    if (!record) return;
    this.clearReconnect(record);
    this.liveRecords.set(record.peerAddress, record);
    this.startLiveHeartbeat();
    this.store.markLive(record);
  }

  recoverRoute(event) {
    const record = this.activeLabels.get(RouteRecord.address(event.peerAddress));
    if (!record) return;
    this.liveRecords.delete(record.peerAddress);
    this.store.markRecovering(record);
    this.scheduleReconnect(record);
  }

  startLiveHeartbeat() {
    if (this.liveHeartbeatTimer || !this.started) return;
    this.liveHeartbeatTimer = this.host.runtime.setTimer(() => {
      this.liveHeartbeatTimer = null;
      this.refreshLiveRoutes();
      this.startLiveHeartbeat();
    }, this.liveHeartbeatMs);
  }

  refreshLiveRoutes() {
    this.liveRecords.forEach((record) => {
      this.store.markLive(record);
    });
  }

  scheduleReconnect(record) {
    this.clearReconnect(record);
    const timer = this.host.runtime.setTimer(() => {
      this.reconnectTimers.delete(record.peerAddress);
      if (!this.started) return;
      this.subscribe(record);
    }, this.reconnectDelayMs);
    this.reconnectTimers.set(record.peerAddress, timer);
  }

  clearReconnect(record) {
    const timer = this.reconnectTimers.get(record.peerAddress);
    if (!timer) return;
    this.host?.runtime.clearTimer(timer);
    this.reconnectTimers.delete(record.peerAddress);
  }

  emit(event) {
    this.handler?.(event);
  }
}
