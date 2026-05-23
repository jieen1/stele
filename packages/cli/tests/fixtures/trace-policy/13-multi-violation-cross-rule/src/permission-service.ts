export class PermissionService {
  verify(actor: string): boolean {
    return actor.length > 0;
  }
}

export const permissionService = new PermissionService();
