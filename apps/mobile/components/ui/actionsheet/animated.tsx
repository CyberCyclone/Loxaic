'use client';
import React from 'react';
import { Pressable, View } from 'react-native';
import type { ViewProps } from 'react-native';
import Animated, {
  Easing,
  SlideInDown,
  SlideOutDown,
} from 'react-native-reanimated';

/**
 * Animated primitives shared by the Actionsheet and Select sheets.
 *
 * gluestack's `createActionsheet` was written against @legendapp/motion and
 * still injects legend-motion style props (`initial` / `animate` / `exit` /
 * `transition`) onto its Content slot. We animate with reanimated layout
 * animations instead — same pattern as Modal/Popover — so `SheetView` swallows
 * those props (they must never reach the native view or the DOM) and positions
 * the sheet by layout (`absolute bottom-0`, set by the caller's className)
 * rather than by the creator's translateY maths.
 */
export const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedView = Animated.createAnimatedComponent(View);

type LegacyMotionProps = {
  initial?: unknown;
  animate?: unknown;
  exit?: unknown;
  transition?: unknown;
};

export type SheetViewProps = ViewProps & LegacyMotionProps;

export const SheetView = React.forwardRef<View, SheetViewProps>(
  function SheetView(
    { initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props },
    ref
  ) {
    return (
      <AnimatedView
        ref={ref}
        entering={SlideInDown.duration(250).easing(Easing.out(Easing.quad))}
        exiting={SlideOutDown.duration(200)}
        {...props}
      />
    );
  }
);
