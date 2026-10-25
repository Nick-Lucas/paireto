import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addItem, type Cart } from "../src/cart.ts";
import { demoCatalog } from "../src/catalog.ts";
import { priceCart } from "../src/checkout.ts";

const empty: Cart = { currency: "GBP", region: "UK", lines: [] };

describe("priceCart", () => {
  it("adds flat-rate shipping below the free shipping threshold", () => {
    const receipt = priceCart(addItem(empty, "MUG-01"), demoCatalog);
    assert.equal(receipt.shipping.amountMinor, 395);
  });

  it("ships for free from £50", () => {
    const receipt = priceCart(addItem(empty, "KETTLE-3", 2), demoCatalog);
    assert.equal(receipt.shipping.amountMinor, 0);
  });

  it("only taxes standard-rated products", () => {
    const cart = addItem(addItem(empty, "MUG-01"), "BEAN-250");
    const receipt = priceCart(cart, demoCatalog);
    assert.equal(receipt.tax.amountMinor, 240);
  });
});
