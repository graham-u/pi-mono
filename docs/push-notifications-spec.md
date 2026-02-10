# Push Notifications

## Overview

Add browser push notifications to the Pi Assistant so that any local process
can send a notification to the user's devices (phone, laptop). Notifications
work even when the browser tab is closed or the phone is locked.

This is a general-purpose notification endpoint — it is not coupled to message
injection. Common use cases:

- Cron scripts alerting the user after injecting a message into the session
- Monitoring scripts alerting about system events (disk space, service down)
- Any backend process that wants to ping the user's devices

### Prerequisites

- The assistant-server must have an HTTP layer (added by the message injection
  work — see `docs/message-injection-spec.md`). The push endpoints are added
  to that same HTTP server.
- The Vite proxy for `/api` must already be configured.

---

## Architecture

```
                                           ┌──────────────────────┐
                                           │  Push Service (FCM)  │
                                           │  (Google's servers)  │
                                           └──────────┬───────────┘
                                                      │ push
                                                      ▼
┌──────────────────────────────────────────────────────────────────┐
│  Browser / Mobile                                                 │
│                                                                   │
│  ┌─────────────────────────────────┐   ┌────────────────────┐   │
│  │  Service Worker (sw.js)          │   │  Pi Assistant App   │   │
│  │  - Receives push events          │   │  - Registers SW     │   │
│  │  - Shows system notification     │   │  - Sends sub to     │   │
│  │  - Works when tab is closed      │   │    server            │   │
│  └─────────────────────────────────┘   └────────────────────┘   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
                                │
                                │ HTTP (subscribe, vapid-public-key)
                                │
┌───────────────────────────────┼───────────────────────────────────┐
│  NUC (Backend)                │                                    │
│                               ▼                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  assistant-server                                           │  │
│  │                                                             │  │
│  │  HTTP endpoints:                                            │  │
│  │    POST /api/push/subscribe     ← store subscription        │  │
│  │    POST /api/push/unsubscribe   ← remove subscription       │  │
│  │    GET  /api/push/vapid-public-key ← for frontend           │  │
│  │    POST /api/push/send          ← send to all devices       │  │
│  │                                                             │  │
│  │  Push subscription store (JSON file on disk)                │  │
│  │  web-push library (sends outbound HTTPS to FCM)             │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  Any local process can call POST /api/push/send:                   │
│    curl, cron script, monitoring daemon, etc.                      │
└────────────────────────────────────────────────────────────────────┘
```

The backend sends notifications outbound to Google's push service. No inbound
ports or public exposure needed. Each browser/device that visits the app and
grants permission gets its own push subscription, stored server-side.

---

## VAPID Keys

Generate once, store in `.env` alongside existing API keys:

```bash
npx web-push generate-vapid-keys
```

Add to `.env`:

```
VAPID_PUBLIC_KEY=BL...long-base64-string
VAPID_PRIVATE_KEY=shorter-base64-string
VAPID_SUBJECT=mailto:you@example.com
```

The `VAPID_SUBJECT` is a contact identifier — a formality for a personal
project. Just use any email you own.

No Google API console, Firebase project, or billing account needed. VAPID keys
are self-generated and self-contained.

---

## Subscription Store

Push subscriptions are stored in a JSON file on disk. Each device gets its own
subscription object:

```
~/.pi/agent/push-subscriptions.json
```

```json
[
  {
    "endpoint": "https://fcm.googleapis.com/fcm/send/...",
    "keys": { "p256dh": "...", "auth": "..." }
  }
]
```

Operations: add (de-duplicate by endpoint), remove, list all. Multiple devices
(phone + laptop) each get their own subscription.

---

## HTTP Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/push/subscribe` | POST | Store a push subscription from the frontend |
| `/api/push/unsubscribe` | POST | Remove a subscription |
| `/api/push/vapid-public-key` | GET | Return the VAPID public key for the frontend |
| `/api/push/send` | POST | Send a notification to all subscribed devices |

All endpoints use localhost-only authentication (same as `/api/inject`).

### POST /api/push/send

The main endpoint for sending notifications. Any local process can call it:

```
POST /api/push/send
Content-Type: application/json

{
  "title": "Pi Assistant",
  "body": "Your daily briefing is ready",
  "url": "/"                               // optional, opened on click
}
```

Example usage from a cron script (after injecting a message):

```bash
curl -s -X POST http://localhost:3001/api/push/send \
  -H "Content-Type: application/json" \
  -d '{"title": "Pi Assistant", "body": "Your daily briefing is ready"}'
```

Example usage for a system alert (no message injection involved):

```bash
curl -s -X POST http://localhost:3001/api/push/send \
  -H "Content-Type: application/json" \
  -d '{"title": "Server Alert", "body": "Disk space below 10%"}'
```

---

## Server-Side Push Utility

```typescript
import webpush from "web-push";

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT!,
  process.env.VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!
);

async function sendPushNotificationToAll(payload: {
  title: string;
  body: string;
  url?: string;
}) {
  const subscriptions = loadSubscriptions(); // from JSON file

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload));
      } catch (err: any) {
        if (err.statusCode === 410) {
          // Subscription expired or revoked — remove it
          removeSubscription(sub.endpoint);
        }
      }
    })
  );
}
```

---

## Service Worker

Plain JavaScript file in `packages/assistant-frontend/public/sw.js`. Vite
serves `public/` files at the root, so it's available at `/sw.js` — the
correct scope for a service worker.

```javascript
self.addEventListener("push", (event) => {
  const data = event.data?.json() ?? { title: "Pi Assistant", body: "New message" };

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",  // optional, add an app icon later
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";

  event.waitUntil(
    clients.matchAll({ type: "window" }).then((windowClients) => {
      // Focus existing tab if open
      for (const client of windowClients) {
        if (client.url.includes(url) && "focus" in client) {
          return client.focus();
        }
      }
      // Otherwise open new tab
      return clients.openWindow(url);
    })
  );
});
```

---

## Frontend Registration

Add push notification registration to `main.ts`, called after the WebSocket
connects. The browser shows a permission prompt on first call. On subsequent
visits, the existing subscription is reused.

```typescript
async function registerPushNotifications() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    console.log("[push] Not supported in this browser");
    return;
  }

  const registration = await navigator.serviceWorker.register("/sw.js");

  // Check if already subscribed
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    await sendSubscriptionToServer(existing);
    return;
  }

  // Fetch VAPID public key from server
  const resp = await fetch("/api/push/vapid-public-key");
  const { key } = await resp.json();

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });

  await sendSubscriptionToServer(subscription);
}

async function sendSubscriptionToServer(sub: PushSubscription) {
  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sub.toJSON()),
  });
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}
```

---

## Notification Behaviour

- **Tab open and focused:** Push notification arrives (harmless alongside
  in-app content).
- **Tab closed / phone locked:** Push notification appears as a system
  notification. Tapping it opens (or focuses) the app.
- **Chrome closed on Android:** Push still arrives — Chrome's background
  service handles it.
- **Multiple devices:** Each device has its own subscription. Both phone and
  laptop receive notifications.
- **Permission denied:** No subscription created, push silently skipped.

### Subscription Lifecycle

| Event | What Happens |
|-------|-------------|
| User visits app for first time | Browser prompts for notification permission |
| User grants permission | Service worker registers, subscription sent to server |
| User visits from another device | Second subscription stored (both receive) |
| User clears browser data | Subscription lost — re-registers on next visit |
| Subscription expires | Server gets 410 on send — removes dead subscription |
| User denies permission | No subscription created — push silently skipped |

---

## Implementation Steps

1. **Generate VAPID keys**, add to `.env`.
2. **Install `web-push`** in assistant-server (`npm install web-push`).
3. **Add subscription store** — JSON file read/write utilities in
   `assistant-server/src/push.ts`.
4. **Add HTTP endpoints** — `/api/push/subscribe`, `/api/push/unsubscribe`,
   `/api/push/vapid-public-key`, `/api/push/send`.
5. **Add `sw.js`** to `assistant-frontend/public/`.
6. **Add registration code** to frontend — new `src/push.ts`, call from
   `main.ts` after connection established.
7. **Test:** subscribe from phone, then:
   ```bash
   curl -X POST http://localhost:3001/api/push/send \
     -H "Content-Type: application/json" \
     -d '{"title": "Test", "body": "Push notification working!"}'
   ```
   Confirm notification appears on phone.
8. **Test tab closed:** close the browser tab, send again — notification should
   still arrive.
9. **Test multi-device:** subscribe from laptop too, confirm both receive.

---

## Files Changed

| File | Change |
|------|--------|
| `assistant-server/src/push.ts` | New — web-push wrapper, subscription store |
| `assistant-server/src/http.ts` | Add `/api/push/*` routes |
| `assistant-server/package.json` | Add `web-push` dependency |
| `assistant-frontend/public/sw.js` | New — service worker |
| `assistant-frontend/src/push.ts` | New — SW registration, subscription management |
| `assistant-frontend/src/main.ts` | Call `registerPushNotifications()` after connect |
| `.env` | Add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` |

## What This Doesn't Require

- No Firebase project or Google Cloud console
- No API keys from Google
- No app installation on the phone (works in the browser)
- No public-facing server (NUC sends outbound HTTPS only)
- No Tailscale changes (existing HTTPS setup is sufficient)

## Open Questions

1. **Notification deduplication.** If both phone and laptop have the tab open,
   both get a push notification (redundant but harmless). Could track "active"
   WebSocket clients to skip push for focused tabs — adds complexity, may not
   be worth it for a personal app.

2. **Subscription persistence across server restarts.** The JSON file handles
   this. Subscriptions survive server restarts; they only expire on the browser
   side (user clears data, subscription TTL expires).
