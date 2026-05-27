/**
 * Stele context for TypeScript contract tests.
 *
 * The exported `steleContext` object is imported by the generated
 * test_contract.ts. Keys must match the (path …) expressions in
 * contract/main.stele. Replace sample data with real fixtures as your
 * project grows.
 */

import type { SteleContext } from "./_stele_runtime.js";
import { sampleItems, sampleOrders, sampleUser } from "../../app/fixtures.js";
import { check as validateSku } from "../../contract/checker_impls/validate-sku.js";
import { check as validateEmail } from "../../contract/checker_impls/validate-email.js";

const user = sampleUser();
const orders = sampleOrders().map((o) => ({ id: o.id, total: o.total }));
const items = sampleItems().map((i) => ({ sku: i.sku, price: i.price, qty: i.qty }));

export const steleContext: SteleContext = {
  user,
  orders,
  items,
  // _stele_checkers maps CDL checker IDs to TypeScript callables.
  // Each callable receives (steleContext, kwargs) and returns
  // { passed: boolean; message: string | null }.
  _stele_checkers: {
    "validate-sku": validateSku,
    "validate-email": validateEmail,
  },
};
