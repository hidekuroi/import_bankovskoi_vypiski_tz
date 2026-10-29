import { useLocalSearchParams, useRouter } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";

import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { Row } from "@/components/row";
import { ThemedText } from "@/components/themed-text";
import { Spacing } from "@/constants/theme";
import { cadenceLabel, formatDay, formatMinor } from "@/core/format";
import { useTheme } from "@/hooks/use-theme";
import { useImportState } from "@/platform/import-engine";

// «Подробнее»: one recurring charge from the server's report. Read-only —
// cancelling a subscription is out of scope for this fragment.
export default function ChargeSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const theme = useTheme();
  const job = useImportState().op?.job;
  const item = job?.report?.items.find((charge) => charge.id === id);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {job?.report && item ? (
        <>
          <View style={styles.header}>
            <ThemedText type="title2">{item.merchant}</ThemedText>
            <ThemedText type="amount">
              {formatMinor(item.amountMinor, job.report.currency)}
            </ThemedText>
            <ThemedText type="subhead" themeColor="textSecondary">
              {cadenceLabel(item.cadence)}
            </ThemedText>
          </View>
          <Card style={{ backgroundColor: theme.fill }}>
            <Row label="Последнее списание" value={formatDay(item.lastSeen)} />
            <Row label="Периодичность" value={cadenceLabel(item.cadence)} />
            <Row label="Валюта" value={job.report.currency} />
            <Row label="Идентификатор" value={item.id} mono />
          </Card>
          <ThemedText type="footnote" themeColor="textTertiary">
            Из отчёта сервера: {job.jobId}, ревизия {job.revision}. Приложение само файл не разбирает.
          </ThemedText>
        </>
      ) : (
        <ThemedText themeColor="textSecondary">Этих данных больше нет: импорт удалён или ещё не готов.</ThemedText>
      )}
      <Button title="Закрыть" variant="secondary" onPress={() => router.back()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: Spacing.five,
    paddingTop: Spacing.six,
    gap: Spacing.four,
  },
  header: {
    gap: Spacing.one,
  },
});
