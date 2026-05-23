import { database } from "../database.js";

// Controller calls Database.query directly — deny-direct violation.
export class UserController {
  show(id: string): unknown {
    return database.query(`SELECT * FROM users WHERE id = '${id}'`);
  }
}
