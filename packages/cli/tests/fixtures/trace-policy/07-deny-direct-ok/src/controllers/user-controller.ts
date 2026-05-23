import { service } from "../service.js";

export class UserController {
  show(id: string): unknown {
    return service.load(id);
  }
}
