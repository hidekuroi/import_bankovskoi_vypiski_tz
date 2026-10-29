import type { RecurringCharge } from "./protocol.ts";

const NBSP = " ";
const NARROW_NBSP = " ";

// Integer minor units in, Russian notation out: 15199 → "151,99 AUD". No
// floating point and no Intl (Hermes formats currencies differently per OS).
// Assumes two-digit minor units, which holds for AUD.
export function formatMinor(amountMinor: number, currency: string): string {
  const sign = amountMinor < 0 ? "−" : "";
  const absolute = Math.abs(amountMinor);
  const units = String(Math.floor(absolute / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, NARROW_NBSP);
  const cents = String(absolute % 100).padStart(2, "0");
  return `${sign}${units},${cents}${NBSP}${currency}`;
}

export function monthlyTotalMinor(items: RecurringCharge[]): number {
  return items.filter((item) => item.cadence === "monthly").reduce((sum, item) => sum + item.amountMinor, 0);
}

const CADENCES: Record<string, string> = {
  weekly: "еженедельно",
  monthly: "ежемесячно",
  yearly: "ежегодно",
};

export function cadenceLabel(cadence: string): string {
  return CADENCES[cadence] ?? cadence;
}

const MONTHS = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

// "2026-10-01" → "1 октября 2026"
export function formatDay(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

// 33882 → "33,1 КБ"
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}${NBSP}Б`;
  const units = ["КБ", "МБ", "ГБ"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 ? Math.round(value).toString() : value.toFixed(1);
  return `${rounded.replace(".", ",")}${NBSP}${units[unit]}`;
}
