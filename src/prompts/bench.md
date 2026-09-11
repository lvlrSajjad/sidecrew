Read the TypeScript module below and answer in markdown.

Produce one table with a row per exported function, with columns: name, parameters (with types),
return type, and whether it can throw. Then, under the heading "Notes", write one sentence per
function describing what it computes. Do not write any code.

```ts
export interface Money { currency: string; minor: number }

export const zero = (currency: string): Money => ({ currency, minor: 0 });

export const add = (a: Money, b: Money): Money => {
  if (a.currency !== b.currency) throw new Error(`cannot add ${a.currency} to ${b.currency}`);
  return { currency: a.currency, minor: a.minor + b.minor };
};

export const subtract = (a: Money, b: Money): Money => add(a, { currency: b.currency, minor: -b.minor });

export const scale = (m: Money, factor: number): Money => {
  if (!Number.isFinite(factor)) throw new RangeError("factor must be finite");
  return { currency: m.currency, minor: Math.round(m.minor * factor) };
};

export const allocate = (m: Money, ratios: number[]): Money[] => {
  const total = ratios.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new RangeError("ratios must sum to a positive number");
  const shares = ratios.map((r) => Math.floor((m.minor * r) / total));
  let remainder = m.minor - shares.reduce((a, b) => a + b, 0);
  for (let i = 0; remainder > 0; i = (i + 1) % shares.length, remainder -= 1) shares[i] += 1;
  return shares.map((minor) => ({ currency: m.currency, minor }));
};

export const compare = (a: Money, b: Money): number => {
  if (a.currency !== b.currency) throw new Error("cannot compare different currencies");
  return a.minor === b.minor ? 0 : a.minor < b.minor ? -1 : 1;
};

export const isZero = (m: Money): boolean => m.minor === 0;

export const negate = (m: Money): Money => ({ currency: m.currency, minor: -m.minor });

export const abs = (m: Money): Money => ({ currency: m.currency, minor: Math.abs(m.minor) });

export const format = (m: Money, locale = "en-US"): string =>
  new Intl.NumberFormat(locale, { style: "currency", currency: m.currency }).format(m.minor / 100);

export const parse = (text: string, currency: string): Money => {
  const match = /^-?\d+(\.\d{1,2})?$/.exec(text.trim());
  if (!match) throw new SyntaxError(`not an amount: ${text}`);
  return { currency, minor: Math.round(Number(text) * 100) };
};

export const sum = (items: Money[]): Money => {
  if (items.length === 0) throw new RangeError("cannot sum an empty list");
  return items.reduce(add);
};
```
