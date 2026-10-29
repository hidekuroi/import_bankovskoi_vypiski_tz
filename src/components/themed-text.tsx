import { StyleSheet, Text, type TextProps } from "react-native";

import { Fonts, type ThemeColor } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

export type ThemedTextProps = TextProps & {
  type?: keyof typeof styles;
  themeColor?: ThemeColor;
};

// Body text follows the system font size all the way up. Text that starts
// large stops earlier, as iOS's own titles do: at the accessibility sizes a
// 22 pt heading would otherwise break mid-word on a 375 pt screen.
const MAX_SCALE: Partial<Record<keyof typeof styles, number>> = {
  title: 1.6,
  title2: 1.6,
  headline: 2.2,
  amount: 1.4,
};

// System fonts at the iOS text-style sizes; they scale with the system font
// size setting on both platforms.
export function ThemedText({
  style,
  type = "body",
  themeColor = "text",
  maxFontSizeMultiplier = MAX_SCALE[type],
  ...rest
}: ThemedTextProps) {
  const theme = useTheme();
  return (
    <Text
      style={[{ color: theme[themeColor] }, styles[type], style]}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 28, lineHeight: 34, fontWeight: "700" },
  title2: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  body: { fontSize: 17, lineHeight: 22 },
  callout: { fontSize: 16, lineHeight: 21 },
  subhead: { fontSize: 15, lineHeight: 20 },
  footnote: { fontSize: 13, lineHeight: 18 },
  caption: { fontSize: 12, lineHeight: 16 },
  mono: { fontFamily: Fonts.mono, fontSize: 12, lineHeight: 17 },
  amount: { fontSize: 40, lineHeight: 46, fontWeight: "700", fontVariant: ["tabular-nums"] },
});
