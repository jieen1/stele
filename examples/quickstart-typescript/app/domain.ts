/**
 * Tiny e-commerce domain model for the Stele TypeScript quickstart demo.
 *
 * Stele contracts (contract/main.stele) enforce business rules on these types
 * without requiring changes here. Run `npx stele generate && npx vitest run`
 * to verify.
 */

export interface Item {
  sku: string;
  price: number;
  qty: number;
}

export interface Order {
  id: string;
  total: number;
  items: Item[];
}

export interface User {
  id: string;
  email: string;
  /** "active" | "suspended" | "deleted" */
  status: string;
}

export type UserStatus = "active" | "suspended" | "deleted";

export const ALLOWED_USER_STATUSES: readonly UserStatus[] = ["active", "suspended", "deleted"];
