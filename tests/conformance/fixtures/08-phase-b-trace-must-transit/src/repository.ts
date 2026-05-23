import { database } from "./database.js";

export class Repository {
  find(id: string): unknown {
    return database.query(`SELECT * FROM users WHERE id = '${id}'`);
  }
}

export const repository = new Repository();
