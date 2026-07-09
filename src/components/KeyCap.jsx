import { useEffect, useRef, useState } from 'react';

/**
 * KeyCap
 * ------
 * One control in the panel: the function label sits ABOVE the cap, the key
 * character is printed ON the cap. It is both clickable/tappable and driven by
 * the physical keyboard (via the `pulse` counter, which the parent bumps each
 * time the bound physical key fires).
 */
function displayKey(key) {
  if (key === ' ') return 'Space';
  return key.toUpperCase();
}

export default function KeyCap({ entry, pulse, onActivate }) {
  const [active, setActive] = useState(false);
  const timerRef = useRef(null);

  // Flash whenever `pulse` changes (i.e. the physical key fired). pulse starts
  // at 0; we only animate on an actual change, so skip the initial mount.
  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    flash();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulse]);

  function flash() {
    setActive(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    // Matches the ~450ms voltage decay in vd-cap-fire (see styles.css).
    timerRef.current = setTimeout(() => setActive(false), 450);
  }

  useEffect(() => () => clearTimeout(timerRef.current), []);

  function handleClick() {
    flash();
    onActivate(entry);
  }

  return (
    <div className="keycap-slot">
      <div className="vd-eyebrow keycap-label">{entry.label}</div>
      <button
        type="button"
        className={`keycap${active ? ' keycap--active' : ''}${
          entry.key === ' ' ? ' keycap--wide' : ''
        }`}
        onClick={handleClick}
        aria-label={`${entry.label} (${displayKey(entry.key)})`}
      >
        {displayKey(entry.key)}
      </button>
    </div>
  );
}
