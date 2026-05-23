import { deprecated } from "./deprecated/legacy.js";

// Path: Controller.show -> Deprecated.legacyLoad -> Database.query.
// Forbidden transit through src/deprecated/**.
export class Controller {
  show(id: string): unknown {
    return deprecated.legacyLoad(id);
  }
}
