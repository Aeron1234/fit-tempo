type Settings = {
  serviceId: string;
  publicKey: string;
  privateKey: string;
  templateId: string;
  summaryTemplateId: string;
  recipient: string;
  frontendUrl: string;
  transport?: typeof fetch;
};

const labels = new Map([
  ['meal_reminder', 'Daily fitness digest'],
  ['weekly_summary', 'Weekly summary'],
  ['milestone', 'Goal milestone'],
  ['inactivity', 'Activity check-in'],
]);

export function createNotificationEmailSender(settings: Settings) {
  const transport = settings.transport ?? fetch;
  const settingsUrl = new URL('/app/notifications', settings.frontendUrl).href;
  return async (message: { to: string; type: string }) => {
    const label = labels.get(message.type);
    if (!label || message.to.toLowerCase() !== settings.recipient.toLowerCase()) return 'rejected' as const;
    try {
      const response = await transport('https://api.emailjs.com/api/v1.0/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
        body: JSON.stringify({
          service_id: settings.serviceId,
          user_id: settings.publicKey,
          accessToken: settings.privateKey,
          template_id: message.type === 'weekly_summary' ? settings.summaryTemplateId : settings.templateId,
          template_params: { to_email: message.to, notification_label: label, settings_url: settingsUrl },
        }),
      });
      void response.body?.cancel().catch(() => undefined);
      if (response.ok) return 'accepted' as const;
      if (response.status === 429) return 'retryable' as const;
      if (response.status >= 400 && response.status < 500 && response.status !== 408) return 'rejected' as const;
      return 'unknown' as const;
    } catch {
      return 'unknown' as const;
    }
  };
}
