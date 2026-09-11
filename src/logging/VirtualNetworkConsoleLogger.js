export class VirtualNetworkConsoleLogger {
  static prefix = '[privatepoker-p2p]';

  static log(label, event) {
    console.debug(`${VirtualNetworkConsoleLogger.prefix} ${label}`, event);
  }
}
