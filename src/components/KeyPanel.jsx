import { KEY_MAP } from '../config.js';
import KeyCap from './KeyCap.jsx';

/**
 * KeyPanel
 * --------
 * The labeled control strip overlaid on the video. Purely presentational:
 * it renders a KeyCap per KEY_MAP entry. Visibility, pulses, and activation
 * are owned by useKeyControls (see App).
 */
export default function KeyPanel({ visible, pulses, onActivate }) {
  return (
    // The dock centers the bus-bar so the panel's own transform stays free for
    // the entrance rise and the hide/show transition.
    <div className="key-panel-dock">
      <div className={`key-panel${visible ? '' : ' key-panel--hidden'}`}>
        {/* Schematic header — a dim node + an eyebrow, voltage-drop style */}
        <div className="key-panel__head">
          <span className="key-panel__node" aria-hidden="true" />
          <span className="vd-eyebrow key-panel__title">Stream Control</span>
        </div>
        <div className="key-panel__row">
          {KEY_MAP.map((entry) => (
            <KeyCap
              key={entry.key}
              entry={entry}
              pulse={pulses[entry.key] || 0}
              onActivate={onActivate}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
