// ============================================================================
//  CONFIG  —  this is the ONLY file you should need to edit.
//
//  1. Point SIGNALING_SERVER_URL / PORT at your TouchDesigner signalingServer.
//  2. Edit KEY_MAP to rename keys / labels / actions.
//  Everything else has sensible defaults.
// ============================================================================

// ---------------------------------------------------------------------------
//  1) SIGNALING SERVER  (your TouchDesigner `signalingServer` COMP)
//
//  This is a WebSocket URL. Use `wss://` when the signalingServer's "Secure"
//  toggle is ON (the normal case — see README for the mkcert TLS setup).
//  Use `ws://` only for an insecure server.
//
//      [SIGNALING_SERVER_URL]   e.g. 'wss://127.0.0.1'  or  'wss://192.168.1.50'
//      [PORT]                   e.g. 443  (the signalingServer COMP's port)
// ---------------------------------------------------------------------------
export const SIGNALING_SERVER_URL = 'wss://127.0.0.1';
export const SIGNALING_SERVER_PORT = 443;

// ---------------------------------------------------------------------------
//  2) THE KEY MAP  —  define every control in this one array.
//
//  Each entry is:
//    key    : the physical keyboard key to listen for. Use a single lowercase
//             character ('q', '1') or ' ' for the spacebar. Matching is
//             case-insensitive.
//    label  : human-readable description shown ABOVE the key cap.
//    action : the identifier sent to TouchDesigner when the key fires. This is
//             the value TD receives as message.action (see DATA_CHANNEL schema
//             below and in the README).
//
//  These are placeholders — rename freely. The panel re-renders automatically.
// ---------------------------------------------------------------------------
export const KEY_MAP = [
  { key: 'q', label: 'Scene 1', action: 'scene_1' },
  { key: 'w', label: 'Scene 2', action: 'scene_2' },
  { key: 'e', label: 'Scene 3', action: 'scene_3' },
  { key: 'r', label: 'Reset', action: 'reset' },
  { key: 't', label: 'Strobe', action: 'strobe' },
  { key: 'y', label: 'Blackout', action: 'blackout' },
  { key: ' ', label: 'Trigger', action: 'trigger' },
];

// ---------------------------------------------------------------------------
//  3) VIDEO DISPLAY
// ---------------------------------------------------------------------------
// 'contain' letterboxes (never crops, may show black bars). 'cover' fills the
// screen and crops the overflow. One-line toggle.
export const VIDEO_FIT = 'contain'; // 'contain' | 'cover'

// Keep true unless TouchDesigner is also sending an audio track. Browsers block
// autoplay WITH sound until a user gesture, so leave this true for hands-off
// installations.
export const VIDEO_MUTED = true;

// ---------------------------------------------------------------------------
//  4) CONTROL PANEL
// ---------------------------------------------------------------------------
export const PANEL_VISIBLE_BY_DEFAULT = true;
// Keys that toggle the panel's visibility (hide for a clean stream / show again).
export const PANEL_TOGGLE_KEYS = ['h', 'Tab'];

// ---------------------------------------------------------------------------
//  5) DATA CHANNEL  (how actions reach TouchDesigner)
//
//  The label of the WebRTC data channel we open. On the TD side this arrives
//  on the WebRTC DAT's callback. Each message is the JSON object built by
//  buildKeyMessage() below — documented in the README.
// ---------------------------------------------------------------------------
export const DATA_CHANNEL_LABEL = 'ControlData';

/**
 * The exact payload sent over the data channel on each key activation.
 * TouchDesigner receives this (as a JSON string) and parses `action`.
 * Keep this in sync with the schema documented in the README.
 */
export function buildKeyMessage(action) {
  return { type: 'key', action };
}

// ---------------------------------------------------------------------------
//  6) WEBRTC / CONNECTION
// ---------------------------------------------------------------------------
// STUN/TURN servers for ICE. Pure-LAN/localhost setups work without STUN, but
// a public STUN server is harmless and helps across subnets.
export const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// Auto-connect only to a signaling peer whose address contains this substring.
// Leave '' to connect to the first available peer (the usual single-TD setup).
export const PEER_ADDRESS_FILTER = '';

// WebSocket auto-reconnect backoff (milliseconds).
export const RECONNECT_MIN_DELAY = 1000;
export const RECONNECT_MAX_DELAY = 10000;

// Metadata envelope stamped onto every signaling message we send. Matches the
// TouchDesigner Signaling API schema; you normally don't need to touch this.
export const SIGNALING_METADATA = {
  apiVersion: '1.0.1',
  compVersion: '1.0.1',
  compOrigin: 'WebRTC',
  projectName: 'TDStreamControl',
};
