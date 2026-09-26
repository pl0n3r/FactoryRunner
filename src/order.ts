import { asRecord, exactKeys, integer, ref, slug, stableSha256, uuid } from './validation.ts';

export type ExecutionOrder = {
  version: 1;
  order_id: string;
  work_item_id: string;
  runner_id: string;
  capability: string;
  attempt: number;
  issued_at: number;
  expires_at: number;
  instruction_ref: string;
};

const ORDER_KEYS = ['version','order_id','work_item_id','runner_id','capability','attempt','issued_at','expires_at','instruction_ref'] as const;

export function parseExecutionOrder(input: unknown): ExecutionOrder {
  const record = asRecord(input, 'ExecutionOrder');
  exactKeys(record, ORDER_KEYS, 'ExecutionOrder');
  if (record.version !== 1) throw new TypeError('Versión de ExecutionOrder no soportada.');
  const issuedAt = integer(record.issued_at, 'issued_at');
  const expiresAt = integer(record.expires_at, 'expires_at', issuedAt + 1);
  if (expiresAt - issuedAt > 86_400) throw new TypeError('TTL de orden excesivo.');
  const instructionRef = ref(record.instruction_ref, 'instruction_ref');
  if (!instructionRef.startsWith('controlbot:')) throw new TypeError('instruction_ref debe ser opaca y pertenecer a ControlBot.');
  return {
    version: 1,
    order_id: uuid(record.order_id, 'order_id'),
    work_item_id: ref(record.work_item_id, 'work_item_id', 160),
    runner_id: uuid(record.runner_id, 'runner_id'),
    capability: slug(record.capability, 'capability'),
    attempt: integer(record.attempt, 'attempt', 1, 10),
    issued_at: issuedAt,
    expires_at: expiresAt,
    instruction_ref: instructionRef,
  };
}

export function orderFingerprint(order: ExecutionOrder): string {
  return stableSha256(order);
}

export function assertIdempotentOrder(existing: ExecutionOrder, incoming: ExecutionOrder): void {
  if (existing.order_id !== incoming.order_id) throw new TypeError('order_id distinto.');
  if (orderFingerprint(existing) !== orderFingerprint(incoming)) {
    throw new TypeError('Reuso conflictivo de order_id.');
  }
}
