type SparklineProps = {
  values: number[];
  positive?: boolean;
  label: string;
  compact?: boolean;
};

export function Sparkline({
  values,
  positive = true,
  label,
  compact = false,
}: SparklineProps) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);

  return (
    <div
      className={`sparkline ${positive ? "positive" : "negative"} ${
        compact ? "compact" : ""
      }`}
      role="img"
      aria-label={label}
    >
      {values.map((value, index) => {
        const height = 20 + ((value - min) / range) * 80;
        return (
          <span
            // The input arrays are stable fixture data, so the index is stable.
            key={index}
            style={{ height: `${height}%` }}
            aria-hidden="true"
          />
        );
      })}
    </div>
  );
}
