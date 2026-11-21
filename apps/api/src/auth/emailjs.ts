import type { AccountEmailSender } from './mailbox.js';

type EmailJsAccountSettings = {
  serviceId: string;
  publicKey: string;
  privateKey: string;
  verifyTemplateId: string;
  resetTemplateId: string;
  reserve: () => Promise<boolean>;
  transport?: typeof fetch;
};

export class EmailJsAccountSendError extends Error {
  constructor(readonly outcome: 'unavailable' | 'rejected' | 'unknown', readonly providerStatus?: number) {
    super(`EmailJS account email outcome: ${outcome}`);
    this.name = 'EmailJsAccountSendError';
  }
}

export function createEmailJsAccountSender(settings: EmailJsAccountSettings): AccountEmailSender {
  const transport = settings.transport ?? fetch;
  const templates = {
    verify_email: settings.verifyTemplateId,
    reset_password: settings.resetTemplateId,
  };

  return {
    async send(message) {
      const reserved = await settings.reserve().catch(() => false);
      if (!reserved) throw new EmailJsAccountSendError('unavailable');

      let response: Response;
      try {
        response = await transport('https://api.emailjs.com/api/v1.0/email/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(5_000),
          body: JSON.stringify({
            service_id: settings.serviceId,
            template_id: templates[message.kind],
            user_id: settings.publicKey,
            accessToken: settings.privateKey,
            template_params: { to_email: message.to, action_url: message.url },
          }),
        });
      } catch {
        throw new EmailJsAccountSendError('unknown');
      }

      // Provider bodies can contain recipient information. Discard them.
      void response.body?.cancel().catch(() => undefined);
      if (response.ok) return;
      const rejected = response.status >= 400 && response.status < 500 && response.status !== 408;
      throw new EmailJsAccountSendError(rejected ? 'rejected' : 'unknown', response.status);
    },
  };
}
