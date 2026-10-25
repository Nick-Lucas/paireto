import type { TaxCategory } from "./catalog.ts";
import { multiply, type Money } from "./money.ts";

export type Region = "UK" | "IE" | "DE";

const RATES: Record<Region, Record<TaxCategory, number>> = {
  UK: { standard: 0.2, reduced: 0.05, zero: 0 },
  IE: { standard: 0.23, reduced: 0.135, zero: 0 },
  DE: { standard: 0.19, reduced: 0.07, zero: 0 },
};

export function taxRate(region: Region, category: TaxCategory): number {
  return RATES[region][category];
}

export function taxFor(amount: Money, region: Region, category: TaxCategory): Money {
  return multiply(amount, taxRate(region, category));
}
