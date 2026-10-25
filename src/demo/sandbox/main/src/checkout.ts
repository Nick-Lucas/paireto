import { priceLines, subtotal as subtotalOf, type Cart, type PricedLine } from "./cart.ts";
import type { Catalog } from "./catalog.ts";
import { add, sum, type Money } from "./money.ts";
import { shippingFor } from "./shipping.ts";
import { taxFor } from "./tax.ts";

export interface Receipt {
  readonly lines: readonly PricedLine[];
  readonly subtotal: Money;
  readonly shipping: Money;
  readonly tax: Money;
  readonly total: Money;
}

export function priceCart(cart: Cart, catalog: Catalog): Receipt {
  const lines = priceLines(cart, catalog);
  const subtotal = subtotalOf(lines, cart.currency);
  const shipping = shippingFor(subtotal, cart.region);
  const tax = sum(
    lines.map((line) => taxFor(line.total, cart.region, line.product.taxCategory)),
    cart.currency,
  );
  return { lines, subtotal, shipping, tax, total: add(add(subtotal, shipping), tax) };
}
