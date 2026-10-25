# Discount codes

Customers can enter one discount code at checkout.

## Rules

- A code is either a percentage off (a whole percent, at most 50%) or a fixed amount off.
- A code can have an expiry date and a minimum spend.
- The discount comes off the subtotal, before shipping and tax. It never takes the subtotal below zero.
- The receipt shows the discount as its own line.

## Decisions

- Free shipping is judged on the discounted subtotal.
- Tax is charged on the discounted amounts. Spread the discount across the lines in proportion to
  their totals.
- Seed the list with a few sample codes. `priceCart` takes the current time as an optional argument,
  so tests stay deterministic.

## Implementation notes

- Put the rules in `src/discounts.ts`. Export `MAX_PERCENT_OFF`, `findDiscount(code)` for looking a
  code up in our static list, and `applyDiscount(subtotal, code, now)`.
- `priceCart` takes the code as an optional argument.
- Cover the rules in `test/discounts.test.ts`.
