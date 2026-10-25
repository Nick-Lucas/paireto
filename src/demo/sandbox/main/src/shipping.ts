import { isAtLeast, money, zero, type Money } from "./money.ts";
import type { Region } from "./tax.ts";

const FREE_SHIPPING_FROM = 5000;

const FLAT_RATE: Record<Region, number> = {
  UK: 395,
  IE: 650,
  DE: 795,
};

export function shippingFor(subtotal: Money, region: Region): Money {
  if (isAtLeast(subtotal, money(FREE_SHIPPING_FROM, subtotal.currency))) {
    return zero(subtotal.currency);
  }
  return money(FLAT_RATE[region], subtotal.currency);
}
