import { NativeTabs } from "expo-router/native-tabs";

import { useTheme } from "@/hooks/use-theme";

const IS_ANDROID = process.env.EXPO_OS === "android";

// Diagnostics is the reviewer's panel and exists in development builds only:
// release builds hide that tab (it can't be navigated to) and, with a single
// tab left, the bar itself.
export default function TabsLayout() {
  const theme = useTheme();

  return (
    <NativeTabs
      hidden={!__DEV__}
      tintColor={theme.tint}
      labelStyle={{
        default: { color: IS_ANDROID ? theme.textSecondary : undefined },
        selected: { color: theme.tint },
      }}
      // iOS draws the bar as Liquid Glass and colours it itself. Android's
      // Material bar would follow the system theme rather than the app's.
      backgroundColor={IS_ANDROID ? theme.surface : undefined}
      indicatorColor={IS_ANDROID ? theme.accentSoft : undefined}
      iconColor={IS_ANDROID ? { default: theme.textSecondary, selected: theme.tint } : undefined}
    >
      <NativeTabs.Trigger name="(import)">
        <NativeTabs.Trigger.Icon sf={{ default: "doc.text", selected: "doc.text.fill" }} md="description" />
        <NativeTabs.Trigger.Label>Импорт</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="(diagnostics)" hidden={!__DEV__}>
        <NativeTabs.Trigger.Icon sf="wrench.and.screwdriver" md="build" />
        <NativeTabs.Trigger.Label>Диагностика</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
