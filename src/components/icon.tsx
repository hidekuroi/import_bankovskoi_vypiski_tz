import { SymbolView, type SymbolViewProps } from "expo-symbols";

export type IconName = SymbolViewProps["name"];

// SF Symbols on iOS, Material Symbols on Android.
export const Icons = {
  document: { ios: "doc.text", android: "description" },
  checked: { ios: "checkmark.circle.fill", android: "check_circle" },
  waiting: { ios: "circle", android: "radio_button_unchecked" },
  warning: { ios: "exclamationmark.circle.fill", android: "error" },
  failed: { ios: "xmark.circle.fill", android: "cancel" },
  info: { ios: "info.circle.fill", android: "info" },
  shield: { ios: "lock.shield", android: "shield_lock" },
  upload: { ios: "arrow.up.doc", android: "upload_file" },
  trash: { ios: "trash", android: "delete" },
  chevron: { ios: "chevron.right", android: "chevron_right" },
  repeat: { ios: "arrow.triangle.2.circlepath", android: "autorenew" },
  noNetwork: { ios: "wifi.slash", android: "wifi_off" },
  noServer: { ios: "icloud.slash", android: "cloud_off" },
} as const satisfies Record<string, IconName>;

type IconProps = {
  name: IconName;
  size?: number;
  color: string;
};

export function Icon({ name, size = 20, color }: IconProps) {
  return <SymbolView name={name} size={size} tintColor={color} />;
}
