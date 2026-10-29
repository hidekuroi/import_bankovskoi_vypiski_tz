import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, { Easing, FadeIn, FadeInDown, LayoutAnimationConfig, LinearTransition, ZoomIn } from "react-native-reanimated";

// Motion only explains a change of state: a new screen state fades in as one
// piece, a block that arrives within it slides up a little, and what was there
// makes room smoothly. Reanimated turns all of it off when the system's
// Reduce Motion setting is on.
const EASE_OUT = Easing.out(Easing.cubic);

export const Motion = {
  stage: FadeIn.duration(220),
  enter: (delay = 0) => FadeInDown.duration(360).delay(delay).easing(EASE_OUT),
  layout: LinearTransition.duration(260).easing(EASE_OUT),
  // A step reaching an outcome (done, failed, needs attention)…
  outcome: ZoomIn.duration(220).easing(EASE_OUT),
  // …and one that merely starts or waits.
  quiet: FadeIn.duration(160),
};

type MotionProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
};

// A whole screen state (start, confirm, progress, deletion). Give it a `key`
// per state: the replacement fades in as one piece, and what it contains
// arrives with it instead of animating on its own.
export function Stage({ children, style }: MotionProps) {
  return (
    <Animated.View entering={Motion.stage} style={style}>
      <LayoutAnimationConfig skipEntering>{children}</LayoutAnimationConfig>
    </Animated.View>
  );
}

// A block that arrives within a stage: slides in, and glides when the blocks
// above it change. Give it a new `key` to animate a replacement in.
export function Appear({ children, style, delay }: MotionProps & { delay?: number }) {
  return (
    <Animated.View entering={Motion.enter(delay)} layout={Motion.layout} style={style}>
      {children}
    </Animated.View>
  );
}

// Doesn't animate in, only glides to its new place.
export function Shift({ children, style }: MotionProps) {
  return (
    <Animated.View layout={Motion.layout} style={style}>
      {children}
    </Animated.View>
  );
}
