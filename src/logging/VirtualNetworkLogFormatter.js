class VirtualNetworkLogDirection {
  static for(event) {
    if (event.type === 'MessageDelivered') return '>>';
    if (event.type === 'MessageReceived') return '<<';
    if (event.type === 'PeerConnected') return '==';
    if (event.type === 'PeerWaiting') return '..';
    if (event.type === 'PeerDisconnected') return '--';
    if (event.type === 'ConnectionTimeout') return '!!';
    if (event.type === 'ConnectionFailed') return '!!';
    if (event.type === 'MeshPollError') return '!!';
    if (event.step === 'AttemptStarted') return '..';
    if (event.step === 'AnnounceSent') return '>>';
    if (event.step === 'AnnounceReceived') return '<<';
    if (event.step === 'OfferRequested') return '<<';
    if (event.step === 'OfferCreating') return '..';
    if (event.step === 'OfferCreated') return '..';
    if (event.step === 'OfferSuppressed') return '--';
    if (event.step === 'ReplacingConnection') return '..';
    if (event.step === 'OfferSent') return '>>';
    if (event.step === 'OfferReceived') return '<<';
    if (event.step === 'AnswerCreating') return '..';
    if (event.step === 'AnswerSent') return '>>';
    if (event.step === 'AnswerReceived') return '<<';
    if (event.step === 'SignalRelayed') return '>>';
    if (event.step === 'RouteAvailable') return '<<';
    if (event.step === 'PreserveRouteRequested') return '>>';
    if (event.step === 'PreserveRouteAccepted') return '<<';
    return '..';
  }
}

class VirtualNetworkLogName {
  static for(event) {
    if (event.type === 'MessageDelivered') return VirtualNetworkLogName.forMessageData(event.messageData);
    if (event.type === 'MessageReceived') return VirtualNetworkLogName.forMessageData(event.messageData);
    if (event.type === 'PeerConnected') return 'Connected';
    if (event.type === 'PeerWaiting') return 'Peer Waiting';
    if (event.type === 'PeerDisconnected') return 'Disconnected';
    if (event.type === 'ConnectionTimeout') return 'Timeout';
    if (event.type === 'ConnectionFailed') return 'Failed';
    if (event.type === 'MeshPollError') return 'Mesh Error';
    if (event.step === 'AttemptStarted') return event.state ?? 'Attempt';
    if (event.step === 'AnnounceSent') return 'Announce';
    if (event.step === 'AnnounceReceived') return 'Announce';
    if (event.step === 'OfferRequested') return 'Offer Request';
    if (event.step === 'OfferCreating') return 'Creating Offer';
    if (event.step === 'OfferCreated') return 'Offer Created';
    if (event.step === 'OfferSuppressed') return 'Offer Suppressed';
    if (event.step === 'ReplacingConnection') return 'Replacing Connection';
    if (event.step === 'OfferSent') return 'Offer';
    if (event.step === 'OfferReceived') return 'Offer';
    if (event.step === 'AnswerCreating') return 'Creating Answer';
    if (event.step === 'AnswerSent') return 'Answer';
    if (event.step === 'AnswerReceived') return 'Answer';
    if (event.step === 'SignalRelayed') return VirtualNetworkLogName.forSignalType(event.messageType);
    if (event.step === 'RouteAvailable') return 'Route';
    if (event.step === 'PreserveRouteRequested') return 'Preserve Route';
    if (event.step === 'PreserveRouteAccepted') return 'Preserve Route';
    return event.step ?? event.type ?? 'Event';
  }

  static forMessageData(messageData) {
    if (messageData?.type === 'sdp-offer') return 'Offer';
    if (messageData?.type === 'sdp-answer') return 'Answer';
    return 'Message';
  }

  static forSignalType(messageType) {
    if (messageType === 'sdp-offer') return 'Offer';
    if (messageType === 'sdp-answer') return 'Answer';
    return messageType ?? 'Signal';
  }
}

class VirtualNetworkLogPeerTag {
  static for(localAddress, event) {
    const address = event.peerAddress ?? event.from ?? event.to ?? localAddress;
    if (!address) return '??';
    return String(address).slice(2, 4).toUpperCase();
  }
}

class VirtualNetworkLogTarget {
  static for(event) {
    if (!VirtualNetworkLogTarget.isLobbyEvent(event)) return '';
    return ' -> Lobby';
  }

  static isLobbyEvent(event) {
    const tableId = event.tableId ?? event.messageData?.tableId;
    if (String(tableId ?? '') === '0') return true;
    if (String(event.backgroundTableId ?? '') === '0') return true;
    if (event.targetRole === 'lobby') return true;
    if (event.messageData?.targetRole === 'lobby') return true;
    return false;
  }
}

export class VirtualNetworkLogFormatter {
  constructor(localAddress, event) {
    this.localAddress = localAddress;
    this.event = event;
  }

  text() {
    const peer = VirtualNetworkLogPeerTag.for(this.localAddress, this.event);
    const direction = VirtualNetworkLogDirection.for(this.event);
    const name = VirtualNetworkLogName.for(this.event);
    const via = this.event.via ? ` via ${this.event.via}` : '';
    const target = VirtualNetworkLogTarget.for(this.event);
    return `[${peer}] ${direction} ${name}${via}${target}`;
  }

  static text(localAddress, event) {
    return new VirtualNetworkLogFormatter(localAddress, event).text();
  }
}
