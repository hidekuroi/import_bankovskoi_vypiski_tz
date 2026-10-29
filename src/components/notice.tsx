import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { Icon, Icons, type IconName } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { Radius, Spacing, type ThemeColor } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import type { Tone } from "@/presentation/import-view";

const TONES = {
  info: { fill: "accentSoft", ink: "tint", icon: Icons.info },
  success: { fill: "successSoft", ink: "success", icon: Icons.checked },
  warning: { fill: "warningSoft", ink: "warning", icon: Icons.warning },
  danger: { fill: "dangerSoft", ink: "danger", icon: Icons.failed },
} as const satisfies Record<Tone, { fill: ThemeColor; ink: ThemeColor; icon: IconName }>;

type NoticeProps = {
  tone: Tone;
  title: string;
  body?: string;
  children?: ReactNode;
};

// A status message. Screen readers hear it when it changes (Android live
// region here, iOS through announceForAccessibility on the screen).
export function Notice({ tone, title, body, children }: NoticeProps) {
  const theme = useTheme();
  const { fill, ink, icon } = TONES[tone];

  return (
    <View style={[styles.notice, { backgroundColor: theme[fill] }]}>
      <View
        accessible
        accessibilityLiveRegion="polite"
        accessibilityLabel={body ? `${title}. ${body}` : title}
        style={styles.message}
      >
        <Icon name={icon} size={22} color={theme[ink]} />
        <View style={styles.texts}>
          <ThemedText type="headline" themeColor={ink}>
            {title}
          </ThemedText>
          {body ? <ThemedText type="subhead">{body}</ThemedText> : null}
        </View>
      </View>
      {children ? <View style={styles.actions}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  notice: {
    borderRadius: Radius.card,
    borderCurve: "continuous",
    padding: Spacing.four,
    gap: Spacing.four,
  },
  message: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing.three,
  },
  texts: {
    flex: 1,
    gap: Spacing.one,
  },
  actions: {
    gap: Spacing.two,
  },
});
