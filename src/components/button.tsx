import { ActivityIndicator, Pressable, StyleSheet } from "react-native";

import { Icon, type IconName } from "@/components/icon";
import { ThemedText } from "@/components/themed-text";
import { Radius, Spacing, type ThemeColor } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

const VARIANTS = {
  primary: { fill: "accent", text: "onAccent" },
  secondary: { fill: "accentSoft", text: "tint" },
  destructive: { fill: "dangerSoft", text: "danger" },
  // On a danger-tinted notice, where the soft variant would vanish.
  danger: { fill: "danger", text: "onDanger" },
  plain: { fill: null, text: "tint" },
} as const satisfies Record<string, { fill: ThemeColor | null; text: ThemeColor }>;

type ButtonProps = {
  title: string;
  onPress: () => void;
  variant?: keyof typeof VARIANTS;
  icon?: IconName;
  disabled?: boolean;
  // Shows a spinner and blocks presses; the title stays, so it still says
  // what is happening.
  loading?: boolean;
  accessibilityHint?: string;
};

// Grows with its label instead of clipping it, so the largest system font
// sizes still fit on a small screen.
export function Button({
  title,
  onPress,
  variant = "primary",
  icon,
  disabled,
  loading,
  accessibilityHint,
}: ButtonProps) {
  const theme = useTheme();
  const { fill, text } = VARIANTS[variant];
  const inactive = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      accessibilityHint={accessibilityHint}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        fill && { backgroundColor: theme[fill] },
        { opacity: pressed ? 0.7 : disabled ? 0.45 : 1 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={theme[text]} />
      ) : icon ? (
        <Icon name={icon} size={18} color={theme[text]} />
      ) : null}
      <ThemedText type="headline" themeColor={text} style={styles.title}>
        {title}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 52,
    borderRadius: Radius.control,
    borderCurve: "continuous",
    paddingHorizontal: Spacing.five,
    paddingVertical: Spacing.three,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.two,
  },
  title: {
    flexShrink: 1,
    textAlign: "center",
  },
});
