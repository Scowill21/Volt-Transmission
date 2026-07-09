import { useEffect, useRef } from 'react';
import { VIDEO_FIT, VIDEO_MUTED } from '../config.js';

/**
 * VideoStage
 * ----------
 * The full-viewport <video> element that renders the incoming TouchDesigner
 * stream. No native controls; letterboxed (or cropped) on a black background.
 * The MediaStream is attached imperatively via a ref whenever it changes.
 */
export default function VideoStage({ stream }) {
  const videoRef = useRef(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.srcObject !== stream) {
      el.srcObject = stream || null;
    }
    if (stream) {
      // Autoplay can be rejected if the gesture/mute rules aren't met; ignore
      // the rejection — muted autoplay is allowed and covers the default case.
      el.play().catch(() => {});
    }
  }, [stream]);

  return (
    <video
      ref={videoRef}
      className="video-stage"
      style={{ objectFit: VIDEO_FIT }}
      autoPlay
      muted={VIDEO_MUTED}
      playsInline
      // no `controls` — this is a display surface, not a player
    />
  );
}
