import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router";
import { Stack } from "expo-router/stack";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { View } from "react-native";

import { OfflineToast } from "@/components/offline-toast";
import { useTheme, type Theme } from "@/hooks/use-theme";
import { startImportEngine } from "@/platform/import-engine";

function navigationTheme(theme: Theme) {
  const base = theme.variant === "dark" ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: theme.tint,
      background: theme.background,
      card: theme.background,
      text: theme.text,
      border: theme.separator,
    },
  };
}

// Tabs at the root (each with its own header stack, see (tabs)/), the charge
// card as a sheet over them, and the offline toast over everything.
export default function RootLayout() {
  const theme = useTheme();

  useEffect(() => {
    startImportEngine();
  }, []);

  return (
    <ThemeProvider value={navigationTheme(theme)}>
      <StatusBar style="auto" />
      <View style={{ flex: 1 }}>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.background } }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen
            name="charge/[id]"
            options={{
              presentation: "formSheet",
              sheetAllowedDetents: [0.6, 1],
              sheetGrabberVisible: true,
              contentStyle: { backgroundColor: theme.surface },
            }}
          />
        </Stack>
        <OfflineToast />
      </View>
    </ThemeProvider>
  );
}
