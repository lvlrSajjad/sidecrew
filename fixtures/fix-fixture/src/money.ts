/** One line of an invoice. `quantity` is optional and means one when it is absent. */
export interface Line {
  label: string;
  amount: number;
  quantity?: number;
}

/** Round to `places` decimal places. */
export function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function lineTotal(line: Line): number {
  return roundTo(line.amount * (line.quantity ?? 1), 2);
}

export function subtotal(lines: Line[]): number {
  return roundTo(lines.reduce((sum, line) => sum + lineTotal(line), 0), 2);
}
