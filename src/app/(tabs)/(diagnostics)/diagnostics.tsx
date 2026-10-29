import { Redirect, useIsFocused } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";

import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { Row, SectionLabel } from "@/components/row";
import { ThemedText } from "@/components/themed-text";
import { MaxContentWidth, Radius, Spacing } from "@/constants/theme";
import { SCENARIOS, type MockState, type Scenario } from "@/core/api";
import type { LogEntry } from "@/core/log";
import { useTheme } from "@/hooks/use-theme";
import {
  API_URL,
  devFlags,
  eventLog,
  importEngine,
  mockControl,
  useEventLog,
  useImportState,
  useStoredOperation,
} from "@/platform/import-engine";

const STAT_LABELS: [keyof MockState["stats"], string][] = [
  ["createRequests", "createRequests (POST)"],
  ["newJobs", "newJobs"],
  ["duplicateHits", "duplicateHits"],
  ["acceptedBytes", "acceptedBytes"],
  ["deleteRequests", "deleteRequests"],
];

// Live counters, polled only while this tab is on screen.
function useMockState() {
  const focused = useIsFocused();
  const [state, setState] = useState<MockState | null>(null);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!focused) return;
    let alive = true;
    const load = () =>
      mockControl.state().then(
        (next) => {
          if (!alive) return;
          setState(next);
          setError(false);
          // A scenario switched from outside the app (curl) counts too.
          if (next.mode !== devFlags.scenario) devFlags.setScenario(next.mode);
        },
        () => alive && setError(true),
      );
    void load();
    const timer = setInterval(load, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [focused, tick]);

  return { state, error, reload: () => setTick((value) => value + 1) };
}

function ScenarioPicker({ current, onPick }: { current: Scenario | undefined; onPick: (mode: Scenario) => void }) {
  const theme = useTheme();
  return (
    <View style={styles.chips}>
      {SCENARIOS.map((mode) => {
        const selected = mode === current;
        return (
          <Pressable
            key={mode}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => onPick(mode)}
            style={[styles.chip, { backgroundColor: selected ? theme.accent : theme.fill }]}
          >
            <ThemedText type="callout" themeColor={selected ? "onAccent" : "text"}>
              {mode}
            </ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}

function formatEntry(entry: LogEntry): string {
  const time = new Date(entry.at).toLocaleTimeString("ru-RU", { hour12: false });
  const fields = Object.entries(entry)
    .filter(([name]) => name !== "at" && name !== "event")
    .map(([name, value]) => `${name}=${value}`)
    .join(" ");
  return `${time} ${entry.event} ${fields}`;
}

// Development builds only; release builds hide the tab (see (tabs)/_layout.tsx).
// The kit's scenario switch and counters, the app's own state and its
// sanitized log, so the acceptance matrix can be walked without curl.
export default function DiagnosticsRoute() {
  return __DEV__ ? <Diagnostics /> : <Redirect href="/" />;
}

function Diagnostics() {
  const mock = useMockState();
  const { op } = useImportState();
  const entries = useEventLog();
  const [autoRecover, setAutoRecover] = useState(devFlags.autoRecover);
  const [autoStale, setAutoStale] = useState(devFlags.autoStaleCheck);
  const serverJob = mock.state?.jobs.find((job) => job.jobId === op?.job?.jobId);
  // What a relaunch would find: read back from the Keychain, not memory.
  const stored = useStoredOperation();
  const pickScenario = (mode: Scenario) =>
    void mockControl.setScenario(mode).then(() => {
      devFlags.setScenario(mode);
      mock.reload();
    }, mock.reload);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <View style={styles.column}>
        <Card>
          <SectionLabel>Mock</SectionLabel>
          <Row label="Адрес" value={API_URL} mono />
          {mock.error ? (
            <ThemedText themeColor="danger">
              Mock недоступен. Запустите `npm start`; для Android нужен `adb reverse tcp:8787 tcp:8787`.
            </ThemedText>
          ) : null}
          <ThemedText type="subhead" themeColor="textSecondary">
            Сценарий
          </ThemedText>
          <ScenarioPicker current={mock.state?.mode} onPick={pickScenario} />
          <View style={styles.switchRow}>
            <ThemedText type="callout" style={styles.switchLabel}>
              stale_status: запрашивать статус автоматически
            </ThemedText>
            <Switch
              value={autoStale}
              onValueChange={(value) => {
                devFlags.autoStaleCheck = value;
                setAutoStale(value);
              }}
            />
          </View>
          <ThemedText type="footnote" themeColor="textSecondary">
            При stale_status второй GET отдаёт устаревший processing/r2. Включено: когда отчёт готов, приложение
            само повторяет запрос, и в журнале появляется snapshot_ignored … ignored=stale. Выключено: потяните экран
            «Импорт» вниз дважды.
          </ThemedText>
          {STAT_LABELS.map(([key, label]) => (
            <Row key={key} label={label} value={mock.state ? String(mock.state.stats[key]) : "—"} mono />
          ))}
          {mock.state?.jobs.map((job) => (
            <Row
              key={job.jobId}
              label={job.jobId}
              value={`${job.status} r${job.revision} · ${job.bytes} B`}
              detail={`sha256 ${job.sha256.slice(0, 12)}…`}
              mono
            />
          ))}
        </Card>

        <Card>
          <SectionLabel>Приложение</SectionLabel>
          <Row label="Фаза" value={op?.phase ?? "нет операции"} mono />
          <Row label="Job" value={op?.job ? `${op.job.jobId} ${op.job.status} r${op.job.revision}` : "—"} mono />
          <Row label="Запись в Keychain" value={stored ? `есть · ${stored.phase}` : "нет"} />
          <Row label="Ключ удаления в записи" value={stored?.deleteKey ? "да" : "нет"} />
          <Row
            label="Имя и хеш файла в записи"
            value={stored ? (stored.file.name || stored.file.sha256 ? "ЕСТЬ" : "нет") : "—"}
          />
          <Row label="Локальная копия файла" value={op?.file.copyUri ? "есть" : "нет"} />
          <Row
            label="Байты на сервере совпадают"
            value={serverJob && op?.file.sha256 ? (serverJob.sha256 === op.file.sha256 ? "да, sha256" : "НЕТ") : "—"}
          />
          <View style={styles.switchRow}>
            <ThemedText type="callout" style={styles.switchLabel}>
              Сразу проверять по ключу после потери ответа
            </ThemedText>
            <Switch
              value={autoRecover}
              onValueChange={(value) => {
                devFlags.setAutoRecover(value);
                setAutoRecover(value);
              }}
            />
          </View>
          <ThemedText type="footnote" themeColor="textSecondary">
            Выключите, чтобы проверить relaunch при lost_ack: после отправки закройте приложение и откройте снова —
            проверка по ключу пройдёт при запуске.
          </ThemedText>
        </Card>

        <View style={styles.buttons}>
          <Button
            title="Сбросить mock и приложение"
            variant="destructive"
            onPress={() => {
              importEngine.resetLocal();
              eventLog.clear();
              void mockControl.reset().then(() => {
                devFlags.setScenario("happy");
                mock.reload();
              }, mock.reload);
            }}
          />
        </View>

        <Card>
          <SectionLabel>Журнал (без данных выписки)</SectionLabel>
          {entries.length === 0 ? (
            <ThemedText type="subhead" themeColor="textSecondary">
              Пока пусто
            </ThemedText>
          ) : (
            entries.map((entry, index) => (
              <ThemedText key={`${entry.at}-${index}`} type="mono" selectable>
                {formatEntry(entry)}
              </ThemedText>
            ))
          )}
        </Card>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: Spacing.four,
    paddingBottom: Spacing.six,
    alignItems: "center",
  },
  column: {
    width: "100%",
    maxWidth: MaxContentWidth,
    gap: Spacing.four,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing.two,
  },
  chip: {
    minHeight: 40,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.control,
    borderCurve: "continuous",
    justifyContent: "center",
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.three,
  },
  switchLabel: {
    flex: 1,
  },
  buttons: {
    gap: Spacing.two,
  },
});
