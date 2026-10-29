import { Platform } from "react-native";

export const Colors = {
  light: {
    background: "#F2F3F6",
    surface: "#FFFFFF",
    // Fills inside a card: chips, inset rows.
    fill: "#EEF0F4",
    text: "#10141A",
    textSecondary: "#4E5866",
    textTertiary: "#6B7584",
    separator: "#E2E5EA",
    border: "#CCD2DA",
    tint: "#2557D6",
    accent: "#2557D6",
    accentSoft: "#E7EDFC",
    onAccent: "#FFFFFF",
    success: "#18794A",
    successSoft: "#E3F3EA",
    warning: "#8A5300",
    warningSoft: "#FFF2D9",
    danger: "#B3261E",
    dangerSoft: "#FCE8E6",
    onDanger: "#FFFFFF",
  },
  dark: {
    background: "#0B0D11",
    surface: "#161A20",
    fill: "#20252D",
    text: "#ECEFF4",
    textSecondary: "#A6AFBB",
    textTertiary: "#8A94A1",
    separator: "#252B34",
    border: "#3A424E",
    tint: "#7EA6FF",
    accent: "#3D6EF0",
    accentSoft: "#18233D",
    onAccent: "#FFFFFF",
    success: "#5BD292",
    successSoft: "#102A1D",
    warning: "#F3C267",
    warningSoft: "#33270E",
    danger: "#FF8A7E",
    dangerSoft: "#3A1715",
    onDanger: "#2B0D0A",
  },
} as const;

export type ThemeColor = keyof typeof Colors.light;

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 12,
  four: 16,
  five: 24,
  six: 32,
} as const;

export const Radius = {
  card: 20,
  control: 14,
} as const;

export const Fonts = {
  mono: Platform.select({ ios: "Menlo", default: "monospace" }),
} as const;

export const MaxContentWidth = 640;
