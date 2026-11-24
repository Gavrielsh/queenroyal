/**
 * Short labels for money strings on small surfaces (wheel slices, streak days):
 * "5000" → "5K", "2500" → "2.5K", "1500000" → "1.5M", "0.2000" → "0.2".
 *
 * Pure string operations — the value is never parsed into a number (G2). Amounts under 1,000
 * keep their (trimmed) decimals; larger ones are cut at one decimal of K/M, which is a
 * display rounding DOWN of the label only, never of any stored or credited value.
 */
export function compactAmount(value: string): string {
  const [rawWhole = "0", fraction = ""] = value.split(".");
  const whole = rawWhole.replace(/^0+(?=\d)/, "");
  const trimmedFraction = fraction.replace(/0+$/, "");

  if (whole.length <= 3) return trimmedFraction ? `${whole}.${trimmedFraction}` : whole;

  const [unitDigits, suffix] = whole.length > 6 ? [6, "M"] : [3, "K"];
  const head = whole.slice(0, whole.length - unitDigits);
  const decimal = whole.charAt(whole.length - unitDigits);
  return decimal === "0" ? `${head}${suffix}` : `${head}.${decimal}${suffix}`;
}
