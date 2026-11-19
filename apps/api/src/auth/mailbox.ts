export type AccountEmail = { to: string; kind: 'verify_email' | 'reset_password'; url: string };
export interface AccountEmailSender {
  send(message: AccountEmail): Promise<void>;
}

/** Test-only injection. Never expose messages as a public API route. */
export function createTestMailbox(production = false): AccountEmailSender & { messages: AccountEmail[] } {
  if (production) throw new Error('The test mailbox is forbidden in production.');
  const messages: AccountEmail[] = [];
  return { messages, async send(message) { messages.push(message); } };
}
