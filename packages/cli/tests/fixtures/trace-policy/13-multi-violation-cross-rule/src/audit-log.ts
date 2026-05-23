export class AuditLog {
  write(event: string): void {
    void event;
  }
}

export const auditLog = new AuditLog();
