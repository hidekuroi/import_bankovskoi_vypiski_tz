import * as Haptics from "expo-haptics";

import type { Feedback } from "@/presentation/feedback";

// iOS: the system notification patterns and a soft impact for taps. Android:
// View haptic constants, which follow the device's own haptic settings and
// need no VIBRATE permission.
const PLAY: Record<Feedback, () => Promise<void>> =
  process.env.EXPO_OS === "android"
    ? {
        tap: () => Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Context_Click),
        success: () => Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Confirm),
        warning: () => Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Reject),
        error: () => Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Reject),
      }
    : {
        tap: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft),
        success: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
        warning: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
        error: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
      };

export function playHaptic(feedback: Feedback) {
  // A device without a haptic engine just stays still.
  PLAY[feedback]().catch(() => {});
}
