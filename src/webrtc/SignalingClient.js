import {
  SIGNALING_METADATA,
  RECONNECT_MIN_DELAY,
  RECONNECT_MAX_DELAY,
} from '../config.js';

/**
 * SignalingClient
 * ---------------
 * Talks to TouchDesigner's `signalingServer` COMP over a WebSocket using the
 * TD Signaling API JSON schema:
 *   https://docs.derivative.ca/Palette:signalingServer#Signaling_API
 *
 * Responsibilities:
 *   - Maintain the WebSocket connection and AUTO-RECONNECT (with backoff) if it
 *     drops — important for an unattended installation.
 *   - Track the roster of other clients in the signaling session.
 *   - Learn our own identity (`self`, including `properties.timeJoined`, which
 *     perfect-negotiation uses to decide who is "polite").
 *   - Forward WebRTC negotiation messages (Offer / Answer / Ice) to the
 *     WebRTCConnection.
 *
 * It owns NO React state directly; it reports out through plain callbacks.
 */
class SignalingClient {
  /**
   * @param {object} opts
   * @param {string} opts.url   e.g. 'wss://127.0.0.1'
   * @param {number} opts.port  e.g. 443
   * @param {(clients: object[], self: object|null) => void} opts.onRoster
   * @param {(state: 'connecting'|'open'|'reconnecting'|'closed') => void} opts.onSocketState
   */
  constructor({ url, port, onRoster, onSocketState }) {
    this.url = url;
    this.port = port;
    this.onRoster = onRoster;
    this.onSocketState = onSocketState;

    this.webSocket = null;
    this.webRTCConnection = null;

    // Signaling session state
    this.clients = []; // other clients: [{ id, address, properties }]
    this.self = null; // our own client record once the server acknowledges us
    this.id = -1;

    // Reconnect bookkeeping
    this.shouldReconnect = true;
    this.reconnectDelay = RECONNECT_MIN_DELAY;
    this.reconnectTimer = null;
  }

  setWebRTCConnection(conn) {
    this.webRTCConnection = conn;
  }

  /** Open (or re-open) the WebSocket connection. */
  connect() {
    this.shouldReconnect = true;
    this._clearReconnectTimer();

    const endpoint = `${this.url}:${this.port}`;
    this.onSocketState?.('connecting');

    try {
      this.webSocket = new WebSocket(endpoint);
    } catch (err) {
      console.error('[SIGNALING] Failed to construct WebSocket', err);
      this._scheduleReconnect();
      return;
    }

    this.webSocket.onopen = () => {
      console.log('[SIGNALING] Connected to', endpoint);
      this.reconnectDelay = RECONNECT_MIN_DELAY; // reset backoff on success
      this.onSocketState?.('open');
    };

    this.webSocket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (err) {
        console.warn('[SIGNALING] Non-JSON message ignored', event.data);
        return;
      }
      this._routeMessage(message);
    };

    this.webSocket.onclose = (event) => {
      console.log('[SIGNALING] Closed', event.code, event.reason);
      // Forget the session; we'll get a fresh identity on reconnect.
      this.self = null;
      this.clients = [];
      this.id = -1;
      this.onRoster?.(this.clients, this.self);

      if (this.shouldReconnect) {
        this._scheduleReconnect();
      } else {
        this.onSocketState?.('closed');
      }
    };

    this.webSocket.onerror = (err) => {
      console.error('[SIGNALING] WebSocket error', err);
      // onclose fires next and drives the reconnect.
    };
  }

  /** Intentional shutdown — stops the reconnect loop. */
  close() {
    this.shouldReconnect = false;
    this._clearReconnectTimer();
    if (this.webSocket) {
      this.webSocket.onclose = null; // avoid triggering reconnect on manual close
      try {
        this.webSocket.close();
      } catch {
        /* ignore */
      }
      this.webSocket = null;
    }
    this.onSocketState?.('closed');
  }

  /** Send a JS object as JSON, if the socket is open. */
  send(obj) {
    if (this.webSocket && this.webSocket.readyState === WebSocket.OPEN) {
      this.webSocket.send(JSON.stringify(obj));
      return true;
    }
    console.warn('[SIGNALING] Tried to send while socket not open', obj);
    return false;
  }

  /** Wrap a payload in the TD signaling envelope and send it. */
  sendSignal(signalingType, target, content) {
    return this.send({
      metadata: { ...SIGNALING_METADATA },
      signalingType,
      sender: null, // the server fills this in
      target,
      content,
    });
  }

  /** Look up a known client's record by id (used to find a peer's properties). */
  getClientById(id) {
    if (this.self && this.self.id === id) return this.self;
    return this.clients.find((c) => c.id === id) || null;
  }

  // -- internals ------------------------------------------------------------

  _scheduleReconnect() {
    this.onSocketState?.('reconnecting');
    this._clearReconnectTimer();
    const delay = this.reconnectDelay;
    console.log(`[SIGNALING] Reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    // Exponential backoff, capped.
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_DELAY);
  }

  _clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Route an incoming signaling message. Roster messages are handled here;
   * Offer / Answer / Ice are delegated to the WebRTCConnection.
   * See the TD Signaling API for the message shapes.
   */
  _routeMessage(message) {
    const { signalingType } = message;

    switch (signalingType) {
      // Full roster, received on join.
      case 'Clients': {
        this.clients = (message.content?.clients || []).filter(
          (c) => c.id !== this.id
        );
        this.onRoster?.(this.clients, this.self);
        break;
      }
      // Another client joined.
      case 'ClientEnter': {
        const client = message.content?.client;
        if (client && client.id !== this.id) {
          const exists = this.clients.some((c) => c.id === client.id);
          if (!exists) this.clients.push(client);
        }
        this.onRoster?.(this.clients, this.self);
        break;
      }
      // Server acknowledging US — carries our id + properties.timeJoined.
      case 'ClientEntered': {
        this.self = message.content?.self || null;
        this.id = this.self?.id ?? -1;
        // Drop ourselves from the roster if we appeared in it.
        this.clients = this.clients.filter((c) => c.id !== this.id);
        this.onRoster?.(this.clients, this.self);
        break;
      }
      // A client left.
      case 'ClientExit': {
        const goneId = message.content?.client?.id ?? message.content?.id;
        this.clients = this.clients.filter((c) => c.id !== goneId);
        this.onRoster?.(this.clients, this.self);
        break;
      }
      // WebRTC negotiation — hand off to the peer connection.
      case 'Offer':
      case 'Answer':
      case 'Ice': {
        if (this.webRTCConnection) {
          this.webRTCConnection.onSignalingMessage(message);
        }
        break;
      }
      default:
        console.log('[SIGNALING] Unhandled message type:', signalingType, message);
    }
  }
}

export default SignalingClient;
