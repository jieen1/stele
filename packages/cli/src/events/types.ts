export type EventType =
  | "violation-detected"
  | "baseline-update"
  | "lock-update"
  | "contract-evolution";

export type SteleEvent = {
  id: string;
  timestamp: string;
  type: EventType;
  version: string;
  project_root: string;
  git_commit?: string;
  git_branch?: string;
  payload: Record<string, unknown>;
  session_id: string;
};
