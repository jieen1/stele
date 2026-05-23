// PermissionService exists but OrderService never calls it before Stripe.create.
export class PermissionService {
  verify(actor: string): boolean {
    return actor.length > 0;
  }
}

export const permissionService = new PermissionService();
