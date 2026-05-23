export class Database {
  query(sql: string): unknown {
    return { sql };
  }
}

export const database = new Database();
