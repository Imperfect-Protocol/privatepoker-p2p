const ports = new Map();
const sessions = new Map();
let nextPortId = 1;

function log(label, detail = {}) {
  console.debug(`[privatepoker-p2p] control-worker.${label}`, detail);
}

function sessionKey(session) {
  return [
    String(session?.role ?? 'peer'),
    String(session?.address ?? '').toLowerCase(),
    String(session?.lobbyId ?? ''),
    String(session?.tableId ?? ''),
  ].join(':');
}

function addSession(session, portId) {
  if (!session) return;
  const key = sessionKey(session);
  const portIds = sessions.get(key) ?? new Set();
  portIds.add(portId);
  sessions.set(key, portIds);
  log('session.register', { key, portId });
}

function removeSession(session, portId) {
  if (!session) return;
  const key = sessionKey(session);
  const portIds = sessions.get(key);
  if (!portIds) return;
  portIds.delete(portId);
  if (portIds.size === 0) sessions.delete(key);
  log('session.unregister', { key, portId });
}

function targetKey(message) {
  if (!message?.to || !message?.targetRole) return null;
  return [
    String(message.targetRole),
    String(message.to).toLowerCase(),
    String(message.lobbyId ?? ''),
    String(message.tableId ?? ''),
  ].join(':');
}

function post(portId, message) {
  const entry = ports.get(portId);
  if (!entry) return false;
  entry.port.postMessage(message);
  return true;
}

function routeEnvelope(envelope, route) {
  return {
    ...envelope,
    route,
  };
}

function postRouteResult(portId, envelope, route, targetCount) {
  post(portId, {
    type: 'CONTROL_ROUTE_RESULT',
    message: envelope.message,
    route,
    targetCount,
  });
}

function broadcast(message, exceptPortId) {
  let sent = false;
  ports.forEach((entry, portId) => {
    if (portId === exceptPortId) return;
    sent = post(portId, message) || sent;
  });
  return sent;
}

function routeControlMessage(envelope, portId) {
  const key = targetKey(envelope.message);
  const targetPortIds = key ? [...(sessions.get(key) ?? [])].filter((targetPortId) => targetPortId !== portId) : [];
  let sent = false;
  targetPortIds.forEach((targetPortId) => {
    sent = post(targetPortId, routeEnvelope(envelope, 'direct')) || sent;
  });
  if (sent) {
    log('route.direct', {
      key,
      fromPortId: portId,
      targetCount: targetPortIds.length,
      messageType: envelope.message?.type,
    });
    postRouteResult(portId, envelope, 'direct', targetPortIds.length);
    return;
  }
  log('route.scatter', {
    key,
    fromPortId: portId,
    messageType: envelope.message?.type,
  });
  broadcast(routeEnvelope(envelope, 'scatter'), portId);
  postRouteResult(portId, envelope, 'scatter', 0);
}

self.onconnect = (event) => {
  const port = event.ports[0];
  const portId = nextPortId;
  nextPortId += 1;
  ports.set(portId, { port });
  log('port.connected', { portId });

  port.onmessage = (messageEvent) => {
    const message = messageEvent.data;
    if (message?.type === 'HEARTBEAT') return;

    if (message?.type === 'REGISTER_SESSION') {
      addSession(message.session, portId);
      return;
    }

    if (message?.type === 'UNREGISTER_SESSION') {
      removeSession(message.session, portId);
      return;
    }

    if (message?.type === 'CONTROL_MESSAGE') {
      routeControlMessage({
        type: 'CONTROL_MESSAGE',
        message: message.message,
      }, portId);
    }
  };

  port.start();
  port.postMessage({ type: 'READY', portId });
};
