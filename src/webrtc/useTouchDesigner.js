import { useEffect, useRef, useState, useCallback } from 'react';
import SignalingClient from './SignalingClient.js';
import WebRTCConnection from './WebRTCConnection.js';
import {
  SIGNALING_SERVER_URL,
  SIGNALING_SERVER_PORT,
  PEER_ADDRESS_FILTER,
} from '../config.js';

/**
 * Connection status surfaced to the UI:
 *   'connecting'   — opening the signaling socket / negotiating, no media yet
 *   'connected'    — peer connection is live and media is flowing
 *   'reconnecting' — we had a link (or the socket dropped) and are retrying
 *   'disconnected' — idle / fully down
 */

/**
 * useTouchDesigner
 * ----------------
 * Owns the imperative WebRTC + signaling stack (kept OUT of React's render
 * cycle on purpose) and exposes a small, declarative surface:
 *
 *   { status, stream, channelOpen, sendAction }
 *
 * Auto-connects to the first available TD signaling peer (optionally filtered
 * by PEER_ADDRESS_FILTER) and auto-reconnects if the link drops.
 */
export default function useTouchDesigner() {
  const [status, setStatus] = useState('connecting');
  const [stream, setStream] = useState(null);
  const [channelOpen, setChannelOpen] = useState(false);

  // Imperative singletons live in refs so they survive re-renders.
  const signalingRef = useRef(null);
  const webRTCRef = useRef(null);

  // Latest socket + peer states, combined into one status by recompute().
  const socketStateRef = useRef('connecting'); // 'connecting'|'open'|'reconnecting'|'closed'
  const peerStateRef = useRef('new'); // RTCPeerConnectionState
  const everConnectedRef = useRef(false);

  // Derive the single user-facing status from socket + peer state.
  const recompute = useCallback(() => {
    const sock = socketStateRef.current;
    const peer = peerStateRef.current;

    let next;
    if (peer === 'connected') {
      next = 'connected';
      everConnectedRef.current = true;
    } else if (sock === 'reconnecting' || peer === 'failed' || peer === 'disconnected') {
      next = everConnectedRef.current ? 'reconnecting' : 'connecting';
    } else if (sock === 'closed') {
      next = everConnectedRef.current ? 'reconnecting' : 'disconnected';
    } else {
      // socket connecting/open but no media yet
      next = 'connecting';
    }
    setStatus(next);
  }, []);

  // Decide whether to (re)start a call based on the current roster.
  const evaluateAutoConnect = useCallback((clients, self) => {
    const conn = webRTCRef.current;
    if (!conn || conn.isActive) return; // already in/attempting a call
    if (!self) return; // need our own identity (timeJoined) first

    const candidates = PEER_ADDRESS_FILTER
      ? clients.filter((c) => (c.address || '').includes(PEER_ADDRESS_FILTER))
      : clients;

    const peer = candidates[0];
    if (peer) {
      console.log('[APP] Auto-connecting to peer:', peer.address);
      conn.startCall(peer.address, peer.properties);
    }
  }, []);

  useEffect(() => {
    const signaling = new SignalingClient({
      url: SIGNALING_SERVER_URL,
      port: SIGNALING_SERVER_PORT,
      onRoster: (clients, self) => {
        evaluateAutoConnect(clients, self);
      },
      onSocketState: (state) => {
        socketStateRef.current = state;
        recompute();
      },
    });

    const webRTC = new WebRTCConnection({
      signalingClient: signaling,
      onStream: (s) => setStream(s),
      onPeerState: (state) => {
        peerStateRef.current = state;
        recompute();
        // On a hard drop, tear down so the next roster event can reconnect.
        if (state === 'failed' || state === 'closed') {
          webRTC.endCall();
          // Re-evaluate against whoever is still in the session.
          evaluateAutoConnect(signaling.clients, signaling.self);
        }
      },
      onChannelState: (open) => setChannelOpen(open),
    });

    signalingRef.current = signaling;
    webRTCRef.current = webRTC;
    signaling.connect();

    return () => {
      webRTC.endCall();
      signaling.close();
      signalingRef.current = null;
      webRTCRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stable callback the UI uses to fire a control action.
  const sendAction = useCallback((action) => {
    return webRTCRef.current?.sendAction(action) ?? false;
  }, []);

  return { status, stream, channelOpen, sendAction };
}
