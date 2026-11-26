# Fit Tempo PWA release

## Install from the website

- Open the Fit Tempo homepage. Choose **Install Fit Tempo** for the browser prompt or the instructions for your device.
- Android Chrome. Open **More**, choose **Install and create shortcut**, then **Install**. Some versions show **Add to Home screen** or **Install app**.
- iPhone Safari. Open **Share** (under **More** in some layouts), choose **Add to Home Screen**, turn on **Open as Web App** if shown, and tap **Add**. If the action is missing, look under **Edit Actions** in the Share sheet.
- If the browser offers no install action, choose **Open web app**. The existing app checks your session and offers sign-in and account creation when needed. A standalone launch opens /app. Sign in there if the installed browser context has no existing session.

[Android Chrome help](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid) · [iPhone Safari help](https://support.apple.com/guide/iphone/iphea86e5236/ios) · [Installation prompts](https://web.dev/learn/pwa/installation-prompt) · [Service worker lifecycle](https://web.dev/articles/service-worker-lifecycle) · [Safe areas](https://webkit.org/blog/7929/designing-websites-for-iphone-x/)

## Serve and inspect the production build

From the repository root:

~~~powershell
npm.cmd run build
npm.cmd run preview --workspace @fit-tempo/web -- --host localhost --strictPort
~~~

Open http://localhost:4173. The production worker registers here because browsers treat localhost as a secure context. For account checks run the local API on port 3001. Vite preview uses the existing API proxy. For physical phones, use an accessible HTTPS staging deployment. An HTTP LAN IP does not provide the production secure context.

In DevTools, inspect the manifest, icons, root worker scope and Cache Storage. Requests for /manifest.webmanifest, /fit-tempo-sw.js, /fit-tempo-192.png, /fit-tempo-512.png and /fit-tempo-maskable.png should return their respective files. Check /app/week and an account URL with a direct load. If install is missing, check the secure context, manifest and icon responses, browser support, installed state, and whether the page is in a private window or embedded browser. A browser can withhold the prompt, so also check its menu.

## Offline and updates

After activation, the worker can reload the anonymous SPA shell and its bundled assets offline. A connection dialog blocks account and tracking actions while the browser reports it is offline. Reconnect or choose **Retry connection**. A form already open stays mounted while the dialog is displayed. Sign-in, account data, tracking, uploads and saves require the server. The worker neither queues writes nor caches API responses, passwords, tokens or personal records. Requests already in flight still use existing application error and retry behavior. If the browser reports an online connection and the API is unreachable, use the normal request recovery controls.

To verify an update, serve build A, open a form or confirmation and check that the worker controls the page. Keep it open, serve a changed build B at the same origin, and trigger an update check from DevTools. Verify the new worker waits and the form stays open. Turn off **Update on reload** and avoid forcing **Skip waiting** during this check. Close all tabs and installed windows for that origin, then relaunch. Verify the new cache is active and the old Fit Tempo cache was removed. Other origins have independent registrations.

## Deployment and device verification

Use the existing Vercel web project and its environment-specific API target. The checked-in rewrite points to staging. Staging still needs a new web deployment and a healthy API before hosted sign-in can be verified. Production gets its own deployment and backend configuration.

On Android Chrome and iPhone Safari, verify browser install and standalone launch, both themes, deep links before and after sign-in, sign-out, and switching accounts. Check touch targets, input focus with the keyboard open, confirmation and picker scrolling, and home indicator clearance. Repeat landing and app layout checks at 320px, 390px and desktop width, then test offline reload, reconnect and a staged update.
