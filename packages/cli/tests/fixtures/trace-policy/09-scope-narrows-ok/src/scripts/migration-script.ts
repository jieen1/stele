import { database } from "../database.js";

// Out of scope — scope pattern only includes src/services/**.
export class MigrationScript {
  run(): unknown {
    return database.query("INSERT INTO migrations VALUES ('init')");
  }
}
