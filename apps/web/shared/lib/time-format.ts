export function formatCompactTimestamp(
  value: string | Date | null | undefined,
  options: {
    emptyFallback?: string;
    now?: Date;
  } = {},
): string {
  const emptyFallback = options.emptyFallback ?? "";
  if (!value) {
    return emptyFallback;
  }
  if (typeof value === "string" && isCompactTimestamp(value)) {
    return value;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return typeof value === "string" ? value : emptyFallback;
  }

  const now = options.now ?? new Date();
  if (isSameLocalDay(date, now)) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  const monthDay = `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`;
  if (date.getFullYear() === now.getFullYear()) {
    return monthDay;
  }

  return `${date.getFullYear()}/${monthDay}`;
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isCompactTimestamp(value: string): boolean {
  return /^(?:\d{2}:\d{2}|\d{2}\/\d{2}|\d{4}\/\d{2}\/\d{2})$/.test(value);
}
