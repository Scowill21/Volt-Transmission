import useTouchDesigner from './webrtc/useTouchDesigner.js';
import useKeyControls from './useKeyControls.js';
import VideoStage from './components/VideoStage.jsx';
import KeyPanel from './components/KeyPanel.jsx';
import StatusIndicator from './components/StatusIndicator.jsx';

/**
 * App
 * ---
 * The whole page: a full-screen TouchDesigner stream with a labeled key panel
 * on top and a small corner status indicator. No other UI.
 */
export default function App() {
  // WebRTC: stream in, sendAction out.
  const { status, stream, sendAction } = useTouchDesigner();

  // Keyboard + click control surface, wired to sendAction.
  const { panelVisible, pulses, activate } = useKeyControls(sendAction);

  return (
    <div className="app">
      <VideoStage stream={stream} />
      <StatusIndicator status={status} />
      <KeyPanel visible={panelVisible} pulses={pulses} onActivate={activate} />
    </div>
  );
}
