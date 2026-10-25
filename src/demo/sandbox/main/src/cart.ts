import { findProduct, type Catalog, type Product } from "./catalog.ts";
import { multiply, sum, type Currency, type Money } from "./money.ts";
import type { Region } from "./tax.ts";

export interface CartLine {
  readonly sku: string;
  readonly quantity: number;
}

export interface Cart {
  readonly currency: Currency;
  readonly region: Region;
  readonly lines: readonly CartLine[];
}

export interface PricedLine {
  readonly product: Product;
  readonly quantity: number;
  readonly total: Money;
}

export function addItem(cart: Cart, sku: string, quantity = 1): Cart {
  const existing = cart.lines.find((line) => line.sku === sku);
  const lines = existing
    ? cart.lines.map((line) =>
        line.sku === sku ? { ...line, quantity: line.quantity + quantity } : line,
      )
    : [...cart.lines, { sku, quantity }];
  return { ...cart, lines };
}

export function removeItem(cart: Cart, sku: string): Cart {
  return { ...cart, lines: cart.lines.filter((line) => line.sku !== sku) };
}

export function priceLines(cart: Cart, catalog: Catalog): PricedLine[] {
  return cart.lines.map((line) => {
    const product = findProduct(catalog, line.sku);
    return { product, quantity: line.quantity, total: multiply(product.price, line.quantity) };
  });
}

export function subtotal(lines: readonly PricedLine[], currency: Currency): Money {
  return sum(
    lines.map((line) => line.total),
    currency,
  );
}
