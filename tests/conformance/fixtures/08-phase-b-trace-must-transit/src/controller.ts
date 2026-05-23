import { database } from "./database.js";

// Controller bypasses Repository and calls Database.query directly — violation.
export class Controller {
  load(id: string): unknown {
    return database.query(`SELECT * FROM users WHERE id = '${id}'`);
  }
}
