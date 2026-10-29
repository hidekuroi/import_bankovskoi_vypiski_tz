import { useEffect, useState } from "react";
import { AccessibilityInfo, Animated as Drag, PanResponder, StyleSheet, View } from "react-native";
import Animated, { FadeInUp, FadeOutUp } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon, Icons } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { Radius, Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { useImportState } from "@/platform/import-engine";
import { useDeviceOnline } from "@/platform/network";

type Problem = "device" | "server";

const CONTENT = {
  device: {
    icon: Icons.noNetwork,
    title: "Нет сети",
    body: "Проверьте подключение. Когда сеть появится, статус обновится сам.",
  },
  server: {
    icon: Icons.noServer,
    title: "Сервер не отвечает",
    body: "Пробуем снова каждые несколько секунд. Файл повторно не отправится.",
  },
} as const;

const DISMISS_DISTANCE = 24;

function Toast({ problem }: { problem: Problem }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [dismissed, setDismissed] = useState(false);
  const [offset] = useState(() => new Drag.Value(0));
  // Follows the finger upwards only; a short or slow swipe springs back.
  const [responder] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dy) > 4,
      onPanResponderMove: (_event, gesture) => offset.setValue(Math.min(gesture.dy, 0)),
      onPanResponderRelease: (_event, gesture) => {
        if (gesture.dy < -DISMISS_DISTANCE || gesture.vy < -0.4) {
          Drag.timing(offset, { toValue: -240, duration: 180, useNativeDriver: true }).start(() => setDismissed(true));
        } else {
          Drag.spring(offset, { toValue: 0, useNativeDriver: true }).start();
        }
      },
      onPanResponderTerminate: () => Drag.spring(offset, { toValue: 0, useNativeDriver: true }).start(),
    }),
  );
  const { icon, title, body } = CONTENT[problem];

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(`${title}. ${body}`);
  }, [title, body]);

  if (dismissed) return null;

  return (
    <Animated.View
      entering={FadeInUp.duration(260)}
      exiting={FadeOutUp.duration(200)}
      pointerEvents="box-none"
      style={[styles.host, { top: insets.top + Spacing.two }]}
    >
      <Drag.View
        {...responder.panHandlers}
        accessible
        accessibilityRole="alert"
        accessibilityLabel={`${title}. ${body}`}
        accessibilityHint="Смахните вверх, чтобы скрыть"
        onAccessibilityEscape={() => setDismissed(true)}
        style={[
          styles.toast,
          {
            backgroundColor: theme.surface,
            borderColor: theme.separator,
            boxShadow: theme.variant === "dark" ? "0 8px 24px rgba(0,0,0,0.5)" : "0 8px 24px rgba(16,20,26,0.16)",
            transform: [{ translateY: offset }],
          },
        ]}
      >
        <Icon name={icon} size={22} color={theme.warning} />
        <View style={styles.texts}>
          <ThemedText type="headline">{title}</ThemedText>
          <ThemedText type="subhead" themeColor="textSecondary">
            {body}
          </ThemedText>
        </View>
        <View style={[styles.grabber, { backgroundColor: theme.border }]} />
      </Drag.View>
    </Animated.View>
  );
}

// Over every screen while the device has no network or the server doesn't
// answer. It leaves by itself once the connection is back; swiped away, it
// stays away until the next outage, because each outage mounts a fresh one.
export function OfflineToast() {
  const deviceOnline = useDeviceOnline();
  const serverDown = useImportState().offline;
  const problem: Problem | null = !deviceOnline ? "device" : serverDown ? "server" : null;
  return problem ? <Toast problem={problem} /> : null;
}

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    left: Spacing.four,
    right: Spacing.four,
    zIndex: 10,
  },
  toast: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing.three,
    padding: Spacing.four,
    paddingBottom: Spacing.five,
    borderRadius: Radius.card,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  texts: {
    flex: 1,
    gap: Spacing.half,
  },
  // Hints that the card can be swiped.
  grabber: {
    position: "absolute",
    bottom: Spacing.two,
    alignSelf: "center",
    left: "45%",
    width: "10%",
    height: 4,
    borderRadius: 2,
  },
});
