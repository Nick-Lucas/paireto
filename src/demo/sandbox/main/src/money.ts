export type Currency = "GBP" | "EUR" | "USD";

export interface Money {
  readonly amountMinor: number;
  readonly currency: Currency;
}

export function money(amountMinor: number, currency: Currency): Money {
  if (!Number.isInteger(amountMinor)) {
    throw new RangeError(`Money must be a whole number of minor units, got ${amountMinor}`);
  }
  return { amountMinor, currency };
}

export function zero(currency: Currency): Money {
  return money(0, currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function multiply(value: Money, factor: number): Money {
  return money(Math.round(value.amountMinor * factor), value.currency);
}

export function sum(values: readonly Money[], currency: Currency): Money {
  return values.reduce(add, zero(currency));
}

export function isAtLeast(value: Money, threshold: Money): boolean {
  assertSameCurrency(value, threshold);
  return value.amountMinor >= threshold.amountMinor;
}

export function format(value: Money): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: value.currency }).format(
    value.amountMinor / 100,
  );
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`Cannot combine ${a.currency} with ${b.currency}`);
  }
}
