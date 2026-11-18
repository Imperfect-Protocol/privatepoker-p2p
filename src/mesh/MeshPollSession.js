import { MeshEndpointSet } from './MeshEndpointSet.js';

/**
 * One mailbox poll session for a (lobby, table, peer) triple.
 *
 * The session keeps a long poll open at all times and sends queued outbound
 * messages on a parallel request. The mesh server drains a mailbox when it
 * answers, so cancelling an in-flight poll to send something new can silently
 * drop messages that were already on the wire.
 */
export class MeshPollSession {
  constructor(fields) {
    this.network = fields.network;
    this.lobbyId = fields.lobbyId;
    this.tableId = fields.tableId;
    this.peer = fields.peer;
    this.endpoints = new MeshEndpointSet(fields.urls);
    this.fetch = fields.fetch ?? ((url, options) => globalThis.fetch(url, options));
    this.queue = [];
    this.aborts = new Set();
    this.flushing = false;
    this.stopped = false;
    this.started = false;
  }

  start() {
    if (this.started || this.endpoints.isEmpty()) return;
    this.started = true;
    void this.run();
  }

  enqueue(message) {
    if (!message || this.stopped) return;
    this.queue.push(message);
    void this.flush();
  }

  stop() {
    this.stopped = true;
    this.aborts.forEach((abort) => abort.abort());
    this.aborts.clear();
  }

  async run() {
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (this.stopped) break;
        if (!this.endpoints.rotate()) {
          this.network.handleMeshPollError(error);
          await this.sleep(1_000);
        }
      }
    }
  }

  /** Send queued messages now without cancelling the reader's long poll. */
  async flush() {
    if (this.stopped || this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    let delivered = false;
    try {
      await this.pollOnce();
      delivered = true;
    } catch (error) {
      if (!this.stopped && !this.endpoints.rotate()) this.network.handleMeshPollError(error);
    } finally {
      this.flushing = false;
      if (delivered && !this.stopped && this.queue.length > 0) void this.flush();
    }
  }

  async pollOnce() {
    const outbound = this.queue.splice(0);
    const abort = new AbortController();
    this.aborts.add(abort);
    try {
      const response = await this.fetch(this.endpoints.current(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: abort.signal,
        body: JSON.stringify({
          lobbyId: this.lobbyId,
          tableId: this.tableId,
          peer: this.peer,
          messages: outbound,
        }),
      });
      if (!response.ok) throw new Error(`private-mesh HTTP ${response.status}`);
      await this.deliver(await response.json().catch(() => null));
    } catch (error) {
      if (this.stopped && error.name === 'AbortError') return;
      this.queue.unshift(...outbound);
      throw error;
    } finally {
      this.aborts.delete(abort);
    }
  }

  async deliver(body) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    for (const message of messages) {
      if (this.stopped) return;
      await this.network.handleMeshMessage(message, (reply) => this.enqueue(reply));
    }
  }

  sleep(milliseconds) {
    return new Promise((resolve) => {
      this.network.network.runtime.setTimer(resolve, milliseconds);
    });
  }
}
