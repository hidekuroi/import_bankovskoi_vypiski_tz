import { ActivityIndicator, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";

import { Icon, Icons } from "@/components/icon";
import { Motion } from "@/components/motion";
import { ThemedText } from "@/components/themed-text";
import { Spacing, type ThemeColor } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import type { StepState, StepView } from "@/presentation/import-view";

const MARKS = {
  done: { icon: Icons.checked, ink: "success" },
  active: { icon: null, ink: "tint" },
  waiting: { icon: Icons.waiting, ink: "border" },
  warning: { icon: Icons.warning, ink: "warning" },
  failed: { icon: Icons.failed, ink: "danger" },
} as const satisfies Record<StepState, { icon: (typeof Icons)[keyof typeof Icons] | null; ink: ThemeColor }>;

const SPOKEN: Record<StepState, string> = {
  done: "выполнено",
  active: "выполняется",
  waiting: "ожидает",
  warning: "требует внимания",
  failed: "ошибка",
};

const MARK_SIZE = 22;

const OUTCOMES = new Set<StepState>(["done", "warning", "failed"]);

export function Steps({ steps }: { steps: StepView[] }) {
  const theme = useTheme();

  return (
    <View>
      {steps.map((step, index) => {
        const mark = MARKS[step.state];
        const last = index === steps.length - 1;
        return (
          <View
            key={step.title}
            accessible
            accessibilityLabel={`${step.title}: ${SPOKEN[step.state]}${step.detail ? `. ${step.detail}` : ""}`}
            style={styles.row}
          >
            <View style={styles.rail}>
              {/* Keyed by state: a step reaching an outcome pops its mark in, a
                  step that starts or waits just fades it. */}
              <Animated.View
                key={step.state}
                entering={OUTCOMES.has(step.state) ? Motion.outcome : Motion.quiet}
                style={styles.mark}
              >
                {mark.icon ? (
                  <Icon name={mark.icon} size={MARK_SIZE} color={theme[mark.ink]} />
                ) : (
                  <ActivityIndicator size="small" color={theme[mark.ink]} />
                )}
              </Animated.View>
              {last ? null : (
                <View
                  style={[
                    styles.line,
                    { backgroundColor: step.state === "done" ? theme.success : theme.separator },
                  ]}
                />
              )}
            </View>
            <View style={[styles.texts, !last && styles.textsSpaced]}>
              <ThemedText type="headline" themeColor={step.state === "waiting" ? "textTertiary" : "text"}>
                {step.title}
              </ThemedText>
              {step.detail ? (
                <ThemedText type="subhead" themeColor="textSecondary">
                  {step.detail}
                </ThemedText>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: Spacing.three,
  },
  rail: {
    alignItems: "center",
    width: MARK_SIZE,
  },
  mark: {
    width: MARK_SIZE,
    height: MARK_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  line: {
    flex: 1,
    width: 2,
    marginVertical: Spacing.one,
    borderRadius: 1,
  },
  texts: {
    flex: 1,
    gap: Spacing.half,
    paddingTop: 1,
  },
  textsSpaced: {
    paddingBottom: Spacing.four,
  },
});
