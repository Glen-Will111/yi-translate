// Message alerts for the Chat tab. Loaded by the app's service worker.

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { body: event.data ? event.data.text() : "" }; }
  const title = data.title || "译 Translate";
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    tag: data.tag || undefined,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/?tab=chat" },
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/?tab=chat";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      client.postMessage({ type: "open-chat" });
      if ("focus" in client) return client.focus();
    }
    return self.clients.openWindow(url);
  })());
});
