// AuditLog exists but OrderService never calls it after Stripe.create.
export class AuditLog {
  write(event: string): void {
    void event;
  }
}

export const auditLog = new AuditLog();
