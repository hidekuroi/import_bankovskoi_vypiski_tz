import { Stack } from "expo-router/stack";
import { Platform } from "react-native";

import { useTheme, type Theme } from "@/hooks/use-theme";

const IS_IOS = process.env.EXPO_OS === "ios";

// iOS 26 puts the collapsed bar on Liquid Glass by itself; before it, the
// content scrolling under a transparent bar needs the system material.
function headerBlur(theme: Theme) {
  if (!IS_IOS || Number.parseInt(String(Platform.Version), 10) >= 26) return "none";
  return theme.variant === "dark" ? "systemChromeMaterialDark" : "systemChromeMaterialLight";
}

// The stack at the root of a tab: on iOS a large title that collapses into the
// bar as the screen scrolls. iOS draws it only over a transparent bar, so the
// screen's ScrollView insets itself under it; Android gets a regular bar.
export function TabStack({ screen, title }: { screen: string; title: string }) {
  const theme = useTheme();

  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: theme.background },
        headerTransparent: IS_IOS,
        headerStyle: IS_IOS ? undefined : { backgroundColor: theme.background },
        headerShadowVisible: false,
        headerTintColor: theme.tint,
        headerTitleStyle: { color: theme.text },
        headerLargeTitle: true,
        headerLargeStyle: { backgroundColor: "transparent" },
        headerLargeTitleStyle: { color: theme.text },
        headerLargeTitleShadowVisible: false,
        headerBlurEffect: headerBlur(theme),
      }}
    >
      <Stack.Screen name={screen} options={{ title }} />
    </Stack>
  );
}
