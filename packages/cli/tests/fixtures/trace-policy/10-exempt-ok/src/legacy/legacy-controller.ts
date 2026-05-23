import { database } from "../database.js";

// Exempted by `(exempt "src/legacy/**::**" ...)`.
export class LegacyController {
  show(id: string): unknown {
    return database.query(`SELECT * FROM users WHERE id = '${id}'`);
  }
}
