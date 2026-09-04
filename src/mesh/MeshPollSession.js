import { MeshEndpointSet } from './MeshEndpointSet.js';

export class MeshPollSession {
  constructor(fields) {
    this.network = fields.network;
    this.lobbyId = fields.lobbyId;
    this.tableId = fields.tableId;
    this.peer = fields.peer;
    this.endpoints = new MeshEndpointSet(fields.urls);
    this.queue = [];
    this.currentAbort = null;
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
    this.currentAbort?.abort();
  }

  stop() {
    this.stopped = true;
    this.currentAbort?.abort();
  }

  async run() {
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.endpoints.rotate()) {
          this.network.handleMeshPollError(error);
          await this.sleep(1_000);
        }
      }
    }
  }

  async pollOnce() {
    const outbound = this.queue.splice(0);
    const abort = new AbortController();
    this.currentAbort = abort;
    try {
      const response = await fetch(this.endpoints.current(), {
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
      if (error.name === 'AbortError') {
        if (outbound.length > 0) this.queue.unshift(...outbound);
      } else {
        this.queue.unshift(...outbound);
        throw error;
      }
    } finally {
      if (this.currentAbort === abort) this.currentAbort = null;
    }
  }

  async deliver(body) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    for (const message of messages) {
      await this.network.handleMeshMessage(message, (reply) => this.enqueue(reply));
    }
  }

  sleep(milliseconds) {
    return new Promise((resolve) => {
      this.network.network.runtime.setTimer(resolve, milliseconds);
    });
  }
}
