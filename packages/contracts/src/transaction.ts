/** Internal protocol input. Authenticate and scope the receipt lookup before calling. */
export interface MutationPrecondition {
  payloadDigest: string;
  expectedRevision: number;
  currentRevision: number;
  receipt: { payloadDigest: string; resultReference: string } | null;
}

export type MutationDecision =
  | { kind: 'replay'; resultReference: string }
  | { kind: 'conflict'; code: 'IDEMPOTENCY_CONFLICT' | 'REVISION_CONFLICT' }
  | { kind: 'proceed' };

/** Pure ordering contract. It neither authorizes a caller nor acquires a database lock. */
export function decideMutationPrecondition(input: MutationPrecondition): MutationDecision {
  if (input.receipt !== null) {
    return input.receipt.payloadDigest === input.payloadDigest
      ? { kind: 'replay', resultReference: input.receipt.resultReference }
      : { kind: 'conflict', code: 'IDEMPOTENCY_CONFLICT' };
  }
  if (input.expectedRevision !== input.currentRevision) {
    return { kind: 'conflict', code: 'REVISION_CONFLICT' };
  }
  return { kind: 'proceed' };
}
