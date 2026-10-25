import { money, type Money } from "./money.ts";

export type TaxCategory = "standard" | "reduced" | "zero";

export interface Product {
  readonly sku: string;
  readonly name: string;
  readonly price: Money;
  readonly taxCategory: TaxCategory;
}

export type Catalog = ReadonlyMap<string, Product>;

export function createCatalog(products: readonly Product[]): Catalog {
  return new Map(products.map((product) => [product.sku, product]));
}

export function findProduct(catalog: Catalog, sku: string): Product {
  const product = catalog.get(sku);
  if (!product) {
    throw new Error(`Unknown product ${sku}`);
  }
  return product;
}

export const demoCatalog = createCatalog([
  { sku: "MUG-01", name: "Enamel mug", price: money(1200, "GBP"), taxCategory: "standard" },
  { sku: "BEAN-250", name: "Coffee beans 250g", price: money(950, "GBP"), taxCategory: "zero" },
  { sku: "BOOK-17", name: "Brewing guide", price: money(1800, "GBP"), taxCategory: "zero" },
  { sku: "KETTLE-3", name: "Pour-over kettle", price: money(4500, "GBP"), taxCategory: "standard" },
]);
