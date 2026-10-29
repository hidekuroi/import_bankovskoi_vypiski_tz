import NetInfo from "@react-native-community/netinfo";
import { useSyncExternalStore } from "react";

// Whether the device has a network at all. NetInfo's reachability probe
// would call an external URL to test the internet; this app talks to nothing
// but its own server, so it stays off.
NetInfo.configure({ reachabilityShouldRun: () => false });

let online = true;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// `onBack` runs each time the device goes from offline to online.
export function watchNetwork(onBack: () => void) {
  return NetInfo.addEventListener((info) => {
    // null is "not known yet": no reason to raise an alarm.
    const next = info.isConnected !== false;
    if (next === online) return;
    online = next;
    listeners.forEach((listener) => listener());
    if (next) onBack();
  });
}

export function useDeviceOnline() {
  return useSyncExternalStore(subscribe, () => online);
}
