export type SyncOp = {
  client_op_id: string;
  op_type: "message.create" | "message.update_meta" | "conversation.create" | "conversation.update_meta" | "usage.record";
  entity_id: string;
  payload: Record<string, unknown>;
  lamport: number;
};

export type SyncPushRequest = {
  device_id: string;
  ops: SyncOp[];
};

export type SyncPushResponse = {
  accepted: Array<{ client_op_id: string; seq: number }>;
  rejected: Array<{ client_op_id: string; reason: string }>;
};

export type SyncPullRequest = {
  since: number;
  limit?: number;
};

export type SyncPullResponse = {
  ops: Array<{ seq: number; op_type: string; entity_id: string; payload: unknown; lamport: number; device_id: string | null; created_at: string }>;
  cursor: number;
};

/** Resolve a conflict: LWW by (lamport, device_id) */
export function resolveLWW<T extends { lamport: number; device_id: string }>(a: T, b: T): T {
  if (a.lamport > b.lamport) return a;
  if (b.lamport > a.lamport) return b;
  return a.device_id > b.device_id ? a : b;
}

/** Detect forks in a message tree: nodes with multiple non-deleted children */
export type ForkGroup = {
  parent_id: string;
  branches: string[]; // leaf message IDs for each branch
};

export function detectForks(
  messages: Array<{ id: string; parent_id: string | null; deleted_at?: string | null }>,
): ForkGroup[] {
  const childrenByParent = new Map<string, string[]>();
  for (const msg of messages) {
    if (msg.deleted_at) continue;
    const key = msg.parent_id || "__root__";
    const list = childrenByParent.get(key) || [];
    list.push(msg.id);
    childrenByParent.set(key, list);
  }
  const forks: ForkGroup[] = [];
  for (const [parent_id, children] of childrenByParent) {
    if (children.length > 1) {
      forks.push({ parent_id: parent_id === "__root__" ? "" : parent_id, branches: children });
    }
  }
  return forks;
}