import { useColorScheme } from "react-native";

import { Colors } from "@/constants/theme";

const THEMES = {
  light: { ...Colors.light, variant: "light" },
  dark: { ...Colors.dark, variant: "dark" },
} as const;

export type Theme = (typeof THEMES)[keyof typeof THEMES];

export function useTheme(): Theme {
  return THEMES[useColorScheme() === "dark" ? "dark" : "light"];
}
