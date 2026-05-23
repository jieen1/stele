import { repository } from "./repository.js";

export class Service {
  load(id: string): unknown {
    return repository.find(id);
  }
}

export const service = new Service();
