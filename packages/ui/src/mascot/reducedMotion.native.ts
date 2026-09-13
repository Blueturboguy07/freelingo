import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
/** Observe the actual native setting. A late initial query cannot overwrite a
 * newer change event, and an unknown/unavailable query keeps decorative motion off. */
export function useMascotReducedMotion(): boolean {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let active = true,
      eventSeen = false;
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
      eventSeen = true;
      if (active) setReduced(value);
    });
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (active && !eventSeen) setReduced(value);
      })
      .catch(() => {
        /* Unknown stays still. */
      });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}
