import { useEffect, useState } from 'react';

/**
 * StatusIndicator
 * ---------------
 * A small, unobtrusive dot + label in the top-right corner. It fades out a
 * couple of seconds after reaching 'connected' so it stays out of the way
 * during a live installation, and reappears if the status changes.
 */
const LABELS = {
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
};

export default function StatusIndicator({ status }) {
  const [faded, setFaded] = useState(false);

  useEffect(() => {
    setFaded(false);
    if (status === 'connected') {
      const t = setTimeout(() => setFaded(true), 2000);
      return () => clearTimeout(t);
    }
  }, [status]);

  return (
    <div
      className={`status status--${status}${faded ? ' status--faded' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className="status__dot" />
      <span className="vd-eyebrow status__label">{LABELS[status] || status}</span>
    </div>
  );
}
