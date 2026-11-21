# Fit Tempo account email setup

The backend sends verification and password reset messages using two fixed EmailJS templates. The official plan page lists two templates and 200 monthly requests for Free. Check remaining capacity in the actual account and the rate limits of the connected sender before enabling it. [EmailJS pricing](https://www.emailjs.com/pricing/)

## Dashboard setup

1. Select a connected sender in **Email Services** and record its service ID. Use a separate sender for a disposable test setup where possible.
2. Create the two templates below in **Email Templates** and record their IDs. In each template set **To Email** to `{{to_email}}` and **From Name** to `Fit Tempo`. Use the connected sender as the from address. Leave CC and BCC blank. Preserve the double braces in the template and keep the subject fixed.
3. Enable non-browser API requests under **Account → Security** and configure private-key authorization. Verify that the templates cannot be sent using only the public key. Perform any live authorization check with the same explicitly authorized test inbox used for delivery testing, since a misconfiguration could result in a send. [Official EmailJS Node instructions](https://github.com/emailjs-com/emailjs-nodejs#usage)

| Template | Fixed subject | Body |
| --- | --- | --- |
| Fit Tempo account verification | Verify your Fit Tempo email | Confirm your email to finish setting up your Fit Tempo account. Open the link below and confirm on the page. The link expires in 24 hours. If you didn't request this, you can ignore this email. |
| Fit Tempo password reset | Reset your Fit Tempo password | We received a request to reset your Fit Tempo password. Open the link below and choose a new password. The link expires in 15 minutes. If you didn't request this, you can ignore this email. |

Include the action link in both templates, using the appropriate fixed label:

```html
<a href="{{action_url}}">Verify email</a>
<a href="{{action_url}}">Reset password</a>
```

## Backend configuration

The default local adapter is `test-mailbox`. To test live EmailJS, supply these values only in the API environment along with the existing database, session, CSRF and Redis settings. Set `FRONTEND_URL` to the canonical app origin so action links reach the correct frontend. Production requires HTTPS.

```dotenv
EMAIL_ADAPTER=emailjs
EMAILJS_SERVICE_ID=
EMAILJS_PUBLIC_KEY=
EMAILJS_PRIVATE_KEY=
EMAILJS_VERIFY_TEMPLATE_ID=
EMAILJS_RESET_TEMPLATE_ID=
```

The adapter uses EmailJS's documented JSON endpoint, sending private authorization as `accessToken`. The Node SDK transport does not expose a cancellation signal. The direct HTTPS request uses an actual five-second abort deadline, refuses redirects and makes one attempt per reservation. EmailJS documents one send request per second. Fit Tempo reserves shared pacing capacity before calling the provider. [EmailJS send API](https://www.emailjs.com/docs/rest-api/send/) · [Node SDK transport](https://github.com/emailjs-com/emailjs-nodejs/blob/main/src/api/sendPost.ts)

## Authorized inbox check

1. Use an explicitly authorized inbox with a fresh disposable Fit Tempo account. Register from the app and record whether provider acceptance was observed. Check the actual inbox separately, including spam, and record whether the message arrived.
2. Open the verification link, submit confirmation, then repeat the same confirmation. Only the first submission can consume the link. Sign in after verification.
3. Request a password reset. Compare the visible recovery response with an unknown account using a fictional address. Open the received reset link and change the password. Repeat the reset with the same link and verify it fails. Verify existing sessions are revoked and the new password works.
4. Record acceptance and inbox receipt separately for each message. A timeout or interrupted connection leaves the send outcome unknown. Check EmailJS history and the authorized inbox before choosing whether to request a new message. Keep credentials and full token-bearing links out of notes.

## Current dashboard result

The reset template was saved as `template_8o13tv8`. The dashboard marks it locked and disabled editing, and it blocked creation of the verification template at the subscription limit. Both existing EU-Connect templates were preserved. Keep the default test mailbox until both Fit Tempo templates are active. Use the dashboard's **Do not save private data** setting on both templates so EmailJS History omits token-bearing parameters. Keep tracking and auto-reply disabled.

## Replacement account

Both Fit Tempo templates were saved and verified editable on the replacement account. The template IDs are `template_zp0p01a` for verification and `template_1n39or3` for reset. Both use the private-history setting. The Gmail service form was prepared with its automatic test email unchecked. The sender still needs owner authorization and service creation before the backend can be enabled. No live send was requested.
