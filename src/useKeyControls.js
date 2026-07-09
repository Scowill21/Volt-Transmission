import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KEY_MAP, PANEL_VISIBLE_BY_DEFAULT, PANEL_TOGGLE_KEYS } from './config.js';

/**
 * useKeyControls
 * --------------
 * The single source of truth for keyboard behaviour:
 *   - Maps physical keys (from KEY_MAP) to actions and fires sendAction().
 *   - DISCRETE input: exactly one message per physical press. Auto-repeat
 *     (holding a key) is debounced via a "pressed" set + the repeat flag.
 *   - preventDefault on every mapped/toggle key so the browser doesn't act
 *     (e.g. Space scrolling, Tab moving focus).
 *   - Drives per-cap "pulse" counters so the matching cap flashes.
 *   - Toggles the panel on PANEL_TOGGLE_KEYS (default H / Tab).
 *
 * Returns:
 *   panelVisible : boolean
 *   pulses       : { [key]: number }  — bump => flash that cap
 *   activate     : (entry) => void    — call from a click/tap (cap self-flashes)
 */
export default function useKeyControls(sendAction) {
  const [panelVisible, setPanelVisible] = useState(PANEL_VISIBLE_BY_DEFAULT);
  const [pulses, setPulses] = useState({});

  // Keys currently held down — guarantees one fire per press across browsers.
  const pressedRef = useRef(new Set());

  // Fast lookup: normalized key char -> entry.
  const lookup = useMemo(() => {
    const m = new Map();
    for (const entry of KEY_MAP) m.set(entry.key.toLowerCase(), entry);
    return m;
  }, []);

  const toggleKeys = useMemo(
    () => new Set(PANEL_TOGGLE_KEYS.map((k) => k.toLowerCase())),
    []
  );

  // Fire an action. `fromPhysical` controls whether we bump the cap's pulse
  // (clicks let the cap flash itself, so we don't double-flash).
  const fire = useCallback(
    (entry, fromPhysical) => {
      sendAction(entry.action);
      if (fromPhysical) {
        setPulses((p) => ({ ...p, [entry.key]: (p[entry.key] || 0) + 1 }));
      }
    },
    [sendAction]
  );

  // Click/tap handler for the caps.
  const activate = useCallback((entry) => fire(entry, false), [fire]);

  useEffect(() => {
    function onKeyDown(event) {
      const k = event.key.toLowerCase();

      // Panel toggle (H / Tab) — fire once per press.
      if (toggleKeys.has(k)) {
        event.preventDefault();
        const id = `toggle:${k}`;
        if (pressedRef.current.has(id)) return;
        pressedRef.current.add(id);
        setPanelVisible((v) => !v);
        return;
      }

      const entry = lookup.get(k);
      if (!entry) return; // unmapped key — let the browser have it

      event.preventDefault();
      // Debounce auto-repeat / held keys: one message per physical press.
      if (event.repeat || pressedRef.current.has(k)) return;
      pressedRef.current.add(k);
      fire(entry, true);
    }

    function onKeyUp(event) {
      const k = event.key.toLowerCase();
      pressedRef.current.delete(k);
      pressedRef.current.delete(`toggle:${k}`);
    }

    // If the window loses focus mid-press we may never get keyup — clear so the
    // next press still registers.
    function onBlur() {
      pressedRef.current.clear();
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [lookup, toggleKeys, fire]);

  return { panelVisible, pulses, activate };
}
