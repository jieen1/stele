import { repository } from "./repository.js";

export class Controller {
  load(id: string): unknown {
    return repository.find(id);
  }
}
