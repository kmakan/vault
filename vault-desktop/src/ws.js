const WS_BASE = 'ws://localhost:9443/ws';

class WsClient {
  constructor() {
    this.ws = null;
    this.handlers = {};
    this.reconnectTimer = null;
    this.subscribedChannels = new Set();
  }

  connect(token) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(`${WS_BASE}?token=${token}`);

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      // Re-subscribe to channels after reconnect
      for (const channel of this.subscribedChannels) {
        this.send({ type: 'subscribe', channel });
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const handler = this.handlers[msg.type];
        if (handler) handler(msg);
      } catch (e) {
        console.warn('[WS] Parse error:', e);
      }
    };

    this.ws.onclose = () => {
      console.log('[WS] Disconnected, reconnecting in 3s...');
      this.reconnectTimer = setTimeout(() => this.connect(token), 3000);
    };

    this.ws.onerror = (err) => {
      console.warn('[WS] Error:', err);
    };
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
    this.ws = null;
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  on(type, handler) {
    this.handlers[type] = handler;
  }

  off(type) {
    delete this.handlers[type];
  }

  subscribe(channel) {
    this.subscribedChannels.add(channel);
    this.send({ type: 'subscribe', channel });
  }

  unsubscribe(channel) {
    this.subscribedChannels.delete(channel);
    this.send({ type: 'unsubscribe', channel });
  }

  sendTyping(chat) {
    this.send({ type: 'typing', chat });
  }
}

export default new WsClient();
