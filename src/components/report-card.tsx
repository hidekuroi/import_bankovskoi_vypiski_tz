import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";

import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { Icons } from "@/components/icon";
import { Appear } from "@/components/motion";
import { SectionLabel } from "@/components/row";
import { ThemedText } from "@/components/themed-text";
import { Spacing } from "@/constants/theme";
import { cadenceLabel, formatDay, formatMinor, monthlyTotalMinor } from "@/core/format";
import type { RecurringCharge } from "@/core/protocol";
import { useTheme } from "@/hooks/use-theme";

function chargesWord(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return "списаний";
  if (ones === 1) return "списание";
  if (ones >= 2 && ones <= 4) return "списания";
  return "списаний";
}

function ChargeRow({ item, currency }: { item: RecurringCharge; currency: string }) {
  const router = useRouter();
  const theme = useTheme();
  const amount = formatMinor(item.amountMinor, currency);

  return (
    <View style={[styles.charge, { borderTopColor: theme.separator }]}>
      <View
        accessible
        accessibilityLabel={`${item.merchant}, ${amount}, ${cadenceLabel(item.cadence)}, последнее списание ${formatDay(item.lastSeen)}`}
        style={styles.chargeText}
      >
        <View style={styles.chargeTop}>
          <ThemedText type="headline" style={styles.merchant}>
            {item.merchant}
          </ThemedText>
          <ThemedText type="headline" style={styles.amount}>
            {amount}
          </ThemedText>
        </View>
        <ThemedText type="subhead" themeColor="textSecondary">
          {cadenceLabel(item.cadence)} · последнее {formatDay(item.lastSeen)}
        </ThemedText>
      </View>
      <Button
        title="Подробнее"
        variant="secondary"
        icon={Icons.chevron}
        accessibilityHint={`Карточка списания ${item.merchant}`}
        onPress={() => router.push({ pathname: "/charge/[id]", params: { id: item.id } })}
      />
    </View>
  );
}

// The server's report. Totals are summed in integer minor units.
export function ReportCard({ currency, items }: { currency: string; items: RecurringCharge[] }) {
  const total = formatMinor(monthlyTotalMinor(items), currency);

  return (
    <Card>
      <SectionLabel>Регулярные списания</SectionLabel>
      <View accessible accessibilityLabel={`Итого ${total} в месяц, ${items.length} ${chargesWord(items.length)}`}>
        <ThemedText type="amount">{total}</ThemedText>
        <ThemedText type="subhead" themeColor="textSecondary">
          в месяц · {items.length} {chargesWord(items.length)}
        </ThemedText>
      </View>
      {/* The rows follow the card in, one beat apart. */}
      {items.map((item, index) => (
        <Appear key={item.id} delay={140 + index * 90}>
          <ChargeRow item={item} currency={currency} />
        </Appear>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  charge: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.three,
    gap: Spacing.three,
  },
  chargeText: {
    gap: Spacing.half,
  },
  chargeTop: {
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: Spacing.three,
  },
  merchant: {
    flexGrow: 1,
  },
  amount: {
    fontVariant: ["tabular-nums"],
  },
});
