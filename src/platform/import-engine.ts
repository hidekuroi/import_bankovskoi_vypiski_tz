import { randomUUID } from "expo-crypto";
import { getDocumentAsync } from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { createImportApi, createMockControl, type Scenario } from "@/core/api";
import { createImportEngine, type PickedFile } from "@/core/engine";
import type { ImportOperation } from "@/core/machine";
import { createEventLog } from "@/core/log";
import { createOperationStore, type KeyValueStorage } from "@/core/store";
import { deviceFiles } from "@/platform/files";
import { deviceHttp } from "@/platform/http";
import { watchNetwork } from "@/platform/network";

// The kit's mock. The iOS simulator shares the Mac's loopback; an Android
// emulator gets there through `adb reverse`, which `npm start` sets up.
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");

// The operation record lives in the Keychain (Android: Keystore-encrypted
// storage, and app backups are off). This-device-only: it is neither synced
// to iCloud Keychain nor restored onto another device from a backup. After
// the first unlock rather than only while unlocked: an upload answer that
// lands on a locked phone still has to be written down.
const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

// Writes are synchronous, deletes are not: a value written while a delete is
// on its way would be deleted with it, so it is written again once the
// delete lands.
const deleting = new Map<string, { pending: number; latest: string | null }>();

const keychain: KeyValueStorage = {
  getString: (key) => SecureStore.getItem(key, KEYCHAIN) || undefined,
  set(key, value) {
    SecureStore.setItem(key, value, KEYCHAIN);
    const entry = deleting.get(key);
    if (entry) entry.latest = value;
  },
  // Blank the value now (load() reads "" as nothing), drop the item after.
  remove(key) {
    SecureStore.setItem(key, "", KEYCHAIN);
    const entry = deleting.get(key) ?? { pending: 0, latest: null };
    entry.pending += 1;
    entry.latest = null;
    deleting.set(key, entry);
    void SecureStore.deleteItemAsync(key, KEYCHAIN)
      .catch(() => {})
      .finally(() => {
        if ((entry.pending -= 1) > 0) return;
        deleting.delete(key);
        if (entry.latest === null) return;
        try {
          SecureStore.setItem(key, entry.latest, KEYCHAIN);
        } catch {
          // Kept in memory; the next transition writes it again.
        }
      });
  },
};

export const operationStore = createOperationStore(keychain);

// iOS keeps Keychain items after the app is deleted. A missing marker in the
// app's own container means a fresh install: forget what a previous install
// left behind.
const installMarker = new File(Paths.document, ".installed");
if (!installMarker.exists) {
  operationStore.save(null);
  installMarker.create();
}

export const eventLog = createEventLog({
  sink: __DEV__ ? (entry) => console.log("[import]", JSON.stringify(entry)) : undefined,
});

// Stale answers the engine dropped so far (see probeStale below).
let staleIgnored = 0;

export const importEngine = createImportEngine({
  api: createImportApi({ baseUrl: API_URL, http: deviceHttp }),
  files: deviceFiles,
  store: operationStore,
  log: (event, fields) => {
    if (event === "snapshot_ignored" && fields?.ignored === "stale") staleIgnored += 1;
    eventLog.log(event, fields);
  },
  newId: randomUUID,
});

// Reviewer-only routes of the mock, for the diagnostics screen.
export const mockControl = createMockControl({ baseUrl: API_URL, http: deviceHttp });

// Diagnostics switches, kept for the life of the process.
export const devFlags = {
  autoRecover: true,
  autoStaleCheck: true,
  // The mock's scenario as the diagnostics screen last saw or set it.
  scenario: null as Scenario | null,
  setAutoRecover(value: boolean) {
    devFlags.autoRecover = value;
    importEngine.setAutoRecover(value);
  },
  setScenario(mode: Scenario) {
    devFlags.scenario = mode;
    void probeStale();
  },
};

const isReadyReport = (op: ImportOperation | null) =>
  op?.phase === "accepted" && op.job?.status === "ready" && op.job.report !== null;

let probing = false;

// Dev builds: stale_status answers a job's second GET (counted from the
// scenario switch) with an older revision, and a ready job isn't polled. With
// the switch on, the app asks again by itself, the way a pull-to-refresh
// would, until the stale answer has come and been dropped.
async function probeStale() {
  if (!__DEV__ || probing || !devFlags.autoStaleCheck || devFlags.scenario !== "stale_status") return;
  if (!isReadyReport(importEngine.getState().op)) return;
  probing = true;
  try {
    const before = staleIgnored;
    for (let attempt = 0; attempt < 3 && staleIgnored === before; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      if (devFlags.scenario !== "stale_status" || !isReadyReport(importEngine.getState().op)) return;
      await importEngine.refresh();
    }
  } finally {
    probing = false;
  }
}

let started = false;

// Once per process: reconcile the stored operation with the server, follow
// foreground/background and the network coming back.
export function startImportEngine() {
  if (started) return;
  started = true;
  importEngine.resume().catch(() => eventLog.log("resume_failed"));
  AppState.addEventListener("change", (status) => importEngine.setForeground(status === "active"));
  watchNetwork(() => void importEngine.reconnect());
  if (__DEV__) {
    // A job that turns ready under stale_status gets probed too.
    let readyJob: string | null = null;
    importEngine.subscribe(() => {
      const op = importEngine.getState().op;
      const job = isReadyReport(op) ? (op?.job?.jobId ?? null) : null;
      if (job === readyJob) return;
      readyJob = job;
      if (job) void probeStale();
    });
  }
}

// The type filter only shapes the picker's list; the content check decides.
const PICKER_TYPES = [
  "application/pdf",
  "text/csv",
  "text/comma-separated-values",
  "application/csv",
  "text/plain",
];

export async function pickStatement(): Promise<PickedFile | null> {
  const result = await getDocumentAsync({
    type: PICKER_TYPES,
    // We make the one private copy ourselves (see platform/files.ts).
    copyToCacheDirectory: false,
    multiple: false,
  });
  if (result.canceled) return null;
  const [asset] = result.assets;
  return { uri: asset.uri, name: asset.name, size: asset.size ?? null };
}

export function useImportState() {
  return useSyncExternalStore(importEngine.subscribe, importEngine.getState);
}

export function useEventLog() {
  return useSyncExternalStore(eventLog.subscribe, eventLog.entries);
}

// The record a relaunch would find, read back from the Keychain on every
// engine change (a write always comes with one). For the diagnostics screen.
export function useStoredOperation(): ImportOperation | null {
  const json = useSyncExternalStore(importEngine.subscribe, () => JSON.stringify(operationStore.load()));
  return JSON.parse(json);
}
