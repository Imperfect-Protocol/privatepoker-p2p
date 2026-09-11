import { RouteRecord } from './RouteRecord.js';

export class RouteLabels {
  static subscription(fields) {
    const record = RouteRecord.from(fields);
    return `lobby:${record.peerAddress}:inbound`;
  }

  static channel(fields) {
    const record = RouteRecord.from(fields);
    return `lobby:${record.peerAddress}:outbound`;
  }
}
