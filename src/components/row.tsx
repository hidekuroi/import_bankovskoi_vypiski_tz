import { StyleSheet, View } from "react-native";

import { ThemedText } from "@/components/themed-text";
import { Spacing } from "@/constants/theme";

type RowProps = {
  label: string;
  value: string;
  detail?: string;
  mono?: boolean;
};

// Label and value side by side; at large text sizes the value drops under the
// label instead of squeezing it.
export function Row({ label, value, detail, mono }: RowProps) {
  return (
    <View accessible accessibilityLabel={`${label}: ${value}${detail ? `, ${detail}` : ""}`} style={styles.row}>
      <ThemedText type="subhead" themeColor="textSecondary" style={styles.label}>
        {label}
      </ThemedText>
      <View style={styles.value}>
        <ThemedText type={mono ? "mono" : "callout"} selectable={mono}>
          {value}
        </ThemedText>
        {detail ? (
          <ThemedText type="footnote" themeColor="textTertiary">
            {detail}
          </ThemedText>
        ) : null}
      </View>
    </View>
  );
}

export function SectionLabel({ children }: { children: string }) {
  return (
    <ThemedText type="footnote" themeColor="textSecondary" accessibilityRole="header" style={styles.section}>
      {children}
    </ThemedText>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: Spacing.three,
    rowGap: Spacing.half,
  },
  label: {
    flexGrow: 1,
  },
  value: {
    flexShrink: 1,
    alignItems: "flex-end",
    marginLeft: "auto",
  },
  section: {
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
});
