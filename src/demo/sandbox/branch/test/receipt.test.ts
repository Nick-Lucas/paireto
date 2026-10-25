import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addItem, type Cart } from "../src/cart.ts";
import { demoCatalog } from "../src/catalog.ts";
import { priceCart } from "../src/checkout.ts";
import { renderReceipt } from "../src/receipt.ts";

const empty: Cart = { currency: "GBP", region: "UK", lines: [] };

describe("renderReceipt", () => {
  it("lists each line and the total", () => {
    const text = renderReceipt(priceCart(addItem(empty, "MUG-01", 2), demoCatalog));
    assert.equal(text.split("\n")[0], "2 × Enamel mug                    £24.00");
    assert.equal(text.split("\n").at(-1), "Total                             £32.75");
  });
});
