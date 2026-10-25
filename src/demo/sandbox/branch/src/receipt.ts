import type { Receipt } from "./checkout.ts";
import { format, type Money } from "./money.ts";

const WIDTH = 40;

export function renderReceipt(receipt: Receipt): string {
  const rows = receipt.lines.map((line) =>
    row(`${line.quantity} × ${line.product.name}`, line.total),
  );
  return [
    ...rows,
    "-".repeat(WIDTH),
    row("Subtotal", receipt.subtotal),
    row("Shipping", receipt.shipping),
    row("VAT", receipt.tax),
    row("Total", receipt.total),
  ].join("\n");
}

function row(label: string, amount: Money): string {
  const price = format(amount);
  return `${label.padEnd(WIDTH - price.length)}${price}`;
}
