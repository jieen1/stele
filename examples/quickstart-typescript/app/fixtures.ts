/**
 * Sample data used by contract tests.
 *
 * Import in tests/contract/stele_context.ts to wire real domain objects into
 * the Stele fixture.
 */

import type { Item, Order, User } from "./domain.js";

export function sampleUser(): User {
  return { id: "usr-001", email: "alice@example.com", status: "active" };
}

export function sampleOrders(): Order[] {
  return [
    {
      id: "ord-001",
      total: 49.99,
      items: [
        { sku: "WIDGET-A1", price: 29.99, qty: 1 },
        { sku: "WIDGET-B2", price: 20.0, qty: 1 },
      ],
    },
    {
      id: "ord-002",
      total: 14.5,
      items: [{ sku: "GADGET-C3", price: 14.5, qty: 1 }],
    },
  ];
}

/** Flat item list used by the SKU_FORMAT checker. */
export function sampleItems(): Item[] {
  return sampleOrders().flatMap((o) => o.items);
}
