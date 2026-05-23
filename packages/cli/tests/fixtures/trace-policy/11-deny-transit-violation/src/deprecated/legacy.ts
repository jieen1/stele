import { database } from "../database.js";

export class Deprecated {
  legacyLoad(id: string): unknown {
    return database.query(`SELECT * FROM legacy WHERE id = '${id}'`);
  }
}

export const deprecated = new Deprecated();
