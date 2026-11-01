// Notebook loader for the phone app: the same lime grading sticker as the web
// (src/components/Loader.jsx). It wobbles, presses into its hard shadow and
// inks a tick, then wipes it. Built from core Views + Animated (native driver),
// so it ships in an OTA update without react-native-svg.

import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, View } from 'react-native';
import { palette } from './theme';

const LOOP_MS = 1600;
const BOX = 52; // design units, matching the web SVG viewBox
const STROKE = 4.5;

// Tick strokes in design units: start point, length and angle.
function stroke(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return { midX: (x1 + x2) / 2, midY: (y1 + y2) / 2, length: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) * (180 / Math.PI) };
}
const SHORT = stroke(14.5, 24.5, 21, 31);
const LONG = stroke(21, 31, 34, 17);

function Stroke({ geometry, unit, progress }) {
  const thickness = STROKE * unit;
  const length = geometry.length * unit + thickness;
  return (
    <View
      style={{
        // Centred on the stroke's midpoint so the default (centre) rotation
        // origin lines it up; no transformOrigin needed.
        position: 'absolute',
        left: geometry.midX * unit - length / 2,
        top: geometry.midY * unit - thickness / 2,
        width: length,
        height: thickness,
        overflow: 'hidden',
        transform: [{ rotate: `${geometry.angle}deg` }],
      }}
    >
      <Animated.View
        style={{
          width: length,
          height: thickness,
          borderRadius: thickness / 2,
          backgroundColor: palette.ink,
          // 0 → 1 draws the stroke in, 1 → 2 slides it out (wipes from the start).
          transform: [{ translateX: progress.interpolate({ inputRange: [0, 1, 2], outputRange: [-length, 0, length] }) }],
        }}
      />
    </View>
  );
}

export default function NotebookLoader({ size = 48, style, accessibilityLabel = 'Loading' }) {
  const [t] = useState(() => new Animated.Value(0));
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((enabled) => { if (active) setReduceMotion(Boolean(enabled)); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (reduceMotion) return undefined;
    const loop = Animated.loop(Animated.timing(t, { toValue: 1, duration: LOOP_MS, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [reduceMotion, t]);

  const unit = size / BOX;
  const disc = 42 * unit;
  const offset = 3.5 * unit;
  const press = 2.5 * unit;

  const { wobble, stamp, shortProgress, longProgress } = useMemo(() => {
    if (reduceMotion) {
      const drawn = new Animated.Value(1);
      return { wobble: '-4deg', stamp: 0, shortProgress: drawn, longProgress: drawn };
    }
    return {
      wobble: t.interpolate({ inputRange: [0, 0.25, 0.5, 0.75, 1], outputRange: ['-7deg', '-1deg', '6deg', '-1deg', '-7deg'] }),
      stamp: t.interpolate({ inputRange: [0, 0.3, 0.4, 0.52, 1], outputRange: [0, 0, press, 0, 0] }),
      shortProgress: t.interpolate({ inputRange: [0, 0.12, 0.25, 0.74, 0.86, 1], outputRange: [0, 0, 1, 1, 2, 2] }),
      longProgress: t.interpolate({ inputRange: [0, 0.25, 0.42, 0.8, 1], outputRange: [0, 0, 1, 1, 2] }),
    };
  }, [press, reduceMotion, t]);

  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={accessibilityLabel} style={[{ width: size, height: size }, style]}>
      <Animated.View style={{ width: size, height: size, transform: [{ rotate: wobble }] }}>
        <View style={{ position: 'absolute', left: 3 * unit + offset, top: 3 * unit + offset, width: disc, height: disc, borderRadius: disc / 2, backgroundColor: palette.ink }} />
        <Animated.View style={{ position: 'absolute', left: 0, top: 0, width: size, height: size, transform: [{ translateX: stamp }, { translateY: stamp }] }}>
          <View style={{ position: 'absolute', left: 3 * unit, top: 3 * unit, width: disc, height: disc, borderRadius: disc / 2, backgroundColor: palette.lime, borderWidth: Math.max(1.5, 2.5 * unit), borderColor: palette.ink }} />
          <Stroke geometry={SHORT} unit={unit} progress={shortProgress} />
          <Stroke geometry={LONG} unit={unit} progress={longProgress} />
        </Animated.View>
      </Animated.View>
    </View>
  );
}
