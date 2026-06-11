/**
 * Display-format an engine decimal string ("1234.5000") with thousands separators using
 * pure string operations — money strings are never parsed into floats, even for rendering.
 */
export function formatBalance(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}
