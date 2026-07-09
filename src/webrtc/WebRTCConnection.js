// Keep the webrtc-adapter shim imported so behaviour stays consistent across
// browsers even as their native WebRTC implementations change. (Imported for
// its side effects; not referenced directly.)
import 'webrtc-adapter';

import { ICE_SERVERS, DATA_CHANNEL_LABEL, buildKeyMessage } from '../config.js';

/**
 * WebRTCConnection
 * ----------------
 * Manages a single RTCPeerConnection to TouchDesigner.
 *
 *   - Receives video (recv-only transceiver) and surfaces the MediaStream via
 *     the onStream callback.
 *   - Opens one data channel (DATA_CHANNEL_LABEL) used to send control actions
 *     BACK to TouchDesigner. sendAction() writes the documented JSON payload.
 *   - Implements the WebRTC "perfect negotiation" pattern adapted to the TD
 *     signaling envelope, so offer glare is handled gracefully.
 *     https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation
 *   - Reports connection state changes via onPeerState so the UI can show
 *     connecting / connected / reconnecting, and restarts ICE on failure.
 */
class WebRTCConnection {
  /**
   * @param {object} opts
   * @param {import('./SignalingClient.js').default} opts.signalingClient
   * @param {(stream: MediaStream|null) => void} opts.onStream
   * @param {(state: RTCPeerConnectionState) => void} opts.onPeerState
   * @param {(open: boolean) => void} opts.onChannelState
   */
  constructor({ signalingClient, onStream, onPeerState, onChannelState }) {
    this.signalingClient = signalingClient;
    this.signalingClient.setWebRTCConnection(this);

    this.onStream = onStream;
    this.onPeerState = onPeerState;
    this.onChannelState = onChannelState;

    this.peerConnection = null;
    this.dataChannel = null;
    this.remoteStream = null;
    this.target = null; // address of the TD peer we're calling

    // Perfect-negotiation flags
    this.polite = false;
    this.makingOffer = false;
    this.isSettingRemoteAnswerPending = false;
  }

  /** True if we currently have a live (or in-progress) peer connection. */
  get isActive() {
    return !!this.peerConnection;
  }

  /**
   * Begin a call to a TD signaling peer. We are the initiator: we add a
   * recv-only video transceiver and create the data channel, which triggers
   * negotiationneeded → we send an Offer.
   *
   * @param {string} address      the peer's signaling address (becomes target)
   * @param {object} properties   the peer's properties (carries timeJoined)
   */
  startCall(address, properties) {
    if (this.peerConnection) {
      console.log('[WEBRTC] startCall ignored — connection already active');
      return;
    }
    this.target = address;

    // Politeness: the client that joined the session LATER is polite. We know
    // our own timeJoined from the ClientEntered message.
    const selfJoined = this.signalingClient.self?.properties?.timeJoined ?? 0;
    const peerJoined = properties?.timeJoined ?? 0;
    this.polite = selfJoined < peerJoined;

    this._createPeerConnection();

    // Receive video only (TD is the sender). Add an audio transceiver too only
    // if you expect audio — leaving it off keeps negotiation lean.
    this.peerConnection.addTransceiver('video', { direction: 'recvonly' });

    // Our channel for sending control actions back to TD.
    this._createDataChannel();
  }

  /** Tear everything down (used on disconnect / cleanup). */
  endCall() {
    this._destroyPeerConnection();
  }

  /** Send a control action to TouchDesigner over the data channel. */
  sendAction(action) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(buildKeyMessage(action)));
      return true;
    }
    console.warn('[WEBRTC] Data channel not open; dropped action:', action);
    return false;
  }

  // -- peer connection lifecycle -------------------------------------------

  _createPeerConnection() {
    this.peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.remoteStream = new MediaStream();
    this.onStream?.(this.remoteStream);

    const pc = this.peerConnection;

    pc.ontrack = (event) => {
      console.log('[WEBRTC] Track received:', event.track.kind);
      this.remoteStream.addTrack(event.track);
      // Re-emit so React re-attaches if needed.
      this.onStream?.(this.remoteStream);
    };

    pc.ondatachannel = (event) => {
      // TD (or a renegotiation) may also open a channel; adopt it for sending
      // if we don't already have one.
      console.log('[WEBRTC] Remote opened data channel:', event.channel.label);
      if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
        this._bindDataChannel(event.channel);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalingClient.sendSignal('Ice', this.target, {
          sdpCandidate: event.candidate.candidate,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          sdpMid: event.candidate.sdpMid,
        });
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.signalingClient.sendSignal('Offer', this.target, {
          sdp: pc.localDescription.sdp,
        });
      } catch (err) {
        console.error('[WEBRTC] negotiationneeded error', err);
      } finally {
        this.makingOffer = false;
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log('[WEBRTC] Connection state:', state);
      this.onPeerState?.(state);

      if (state === 'failed') {
        // Lost the media path — try an ICE restart before giving up.
        console.log('[WEBRTC] Connection failed; restarting ICE');
        try {
          pc.restartIce();
        } catch (err) {
          console.error('[WEBRTC] restartIce failed', err);
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[WEBRTC] ICE connection state:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        try {
          pc.restartIce();
        } catch {
          /* ignore */
        }
      }
    };
  }

  _destroyPeerConnection() {
    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch {
        /* ignore */
      }
      this.dataChannel = null;
      this.onChannelState?.(false);
    }

    if (this.peerConnection) {
      const pc = this.peerConnection;
      pc.ontrack = null;
      pc.ondatachannel = null;
      pc.onicecandidate = null;
      pc.onnegotiationneeded = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      this.peerConnection = null;
    }

    if (this.remoteStream) {
      this.remoteStream.getTracks().forEach((t) => t.stop());
      this.remoteStream = null;
    }
    this.onStream?.(null);

    // Reset negotiation flags for a clean re-attempt.
    this.makingOffer = false;
    this.isSettingRemoteAnswerPending = false;
    this.target = null;
  }

  // -- data channel ---------------------------------------------------------

  _createDataChannel() {
    const channel = this.peerConnection.createDataChannel(DATA_CHANNEL_LABEL);
    this._bindDataChannel(channel);
  }

  _bindDataChannel(channel) {
    this.dataChannel = channel;
    channel.onopen = () => {
      console.log('[WEBRTC] Data channel open:', channel.label);
      this.onChannelState?.(true);
    };
    channel.onclose = () => {
      console.log('[WEBRTC] Data channel closed:', channel.label);
      this.onChannelState?.(false);
    };
    channel.onmessage = (event) => {
      // We mostly send; log anything TD sends back for debugging.
      console.log('[WEBRTC] Data channel message from TD:', event.data);
    };
  }

  // -- signaling negotiation (perfect negotiation) --------------------------

  /** Entry point for Offer / Answer / Ice messages from the signaling client. */
  onSignalingMessage(message) {
    switch (message.signalingType) {
      case 'Offer':
        return this._onOffer(message);
      case 'Answer':
        return this._onAnswer(message);
      case 'Ice':
        return this._onIce(message);
      default:
        return undefined;
    }
  }

  async _onOffer(message) {
    // An offer arrived before/instead of us initiating — make sure we have a PC.
    if (!this.peerConnection) {
      // Adopt the sender as our target and derive politeness from their props.
      const senderRecord = this.signalingClient.getClientById(message.sender);
      this.target = senderRecord?.address ?? message.sender;
      const selfJoined = this.signalingClient.self?.properties?.timeJoined ?? 0;
      const peerJoined = senderRecord?.properties?.timeJoined ?? 0;
      this.polite = selfJoined < peerJoined;
      this._createPeerConnection();
    }

    const pc = this.peerConnection;
    const description = { type: 'offer', sdp: message.content.sdp };

    const readyForOffer =
      !this.makingOffer &&
      (pc.signalingState === 'stable' || this.isSettingRemoteAnswerPending);
    const offerCollision = !readyForOffer;

    if (!this.polite && offerCollision) {
      console.log('[WEBRTC] Offer collision and we are impolite — ignoring');
      return;
    }

    this.target = message.sender;
    try {
      await pc.setRemoteDescription(description);
      await pc.setLocalDescription(); // creates the answer
      this.signalingClient.sendSignal('Answer', message.sender, {
        sdp: pc.localDescription.sdp,
      });
    } catch (err) {
      console.error('[WEBRTC] Error handling offer', err);
    }
  }

  async _onAnswer(message) {
    if (!this.peerConnection) return;
    try {
      this.isSettingRemoteAnswerPending = true;
      await this.peerConnection.setRemoteDescription({
        type: 'answer',
        sdp: message.content.sdp,
      });
    } catch (err) {
      console.error('[WEBRTC] Error handling answer', err);
    } finally {
      this.isSettingRemoteAnswerPending = false;
    }
  }

  async _onIce(message) {
    if (!this.peerConnection) return;
    const candidate = new RTCIceCandidate({
      candidate: message.content.sdpCandidate,
      sdpMLineIndex: message.content.sdpMLineIndex,
      sdpMid: message.content.sdpMid,
    });
    try {
      await this.peerConnection.addIceCandidate(candidate);
    } catch (err) {
      // Expected to occasionally fail during glare; only surface if not ignoring.
      if (!this.polite) console.warn('[WEBRTC] addIceCandidate error', err);
    }
  }
}

export default WebRTCConnection;
