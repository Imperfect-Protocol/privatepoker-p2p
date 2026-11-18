export class VirtualNetworkConsoleLogger {
  static prefix = '[privatepoker-p2p]';

  static sequence = 0;

  static listeners = new Set();

  static log(label, event) {
    const record = {
      id: `${Date.now()}:${VirtualNetworkConsoleLogger.sequence++}`,
      label,
      event,
      at: Date.now(),
    };
    console.debug(`${VirtualNetworkConsoleLogger.prefix} ${label}`, event);
    VirtualNetworkConsoleLogger.listeners.forEach((listener) => listener(record));
  }

  static subscribe(listener) {
    VirtualNetworkConsoleLogger.listeners.add(listener);
    return () => VirtualNetworkConsoleLogger.listeners.delete(listener);
  }
}
