// Lola — Service Worker
// يفضل شغال في خلفية المتصفح حتى لو قفلت التاب خالص. مسؤوليته الوحيدة هنا:
// يستقبل push event لما السيرفر يبعت إشعار، ويعرضه على الشاشة.

self.addEventListener('install', (event) => {
  self.skipWaiting(); // فعّل النسخة الجديدة من الـ service worker فورًا من غير ما تستنى قفل كل التابات
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'Lola', body: 'عندك تذكير جديد', tag: 'lola-reminder' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {
    // fallback لو الرسالة مش JSON لأي سبب
  }

  const options = {
    body: data.body,
    tag: data.tag,               // نفس الـ tag بيستبدل الإشعار القديم بدل ما يكوّم إشعارات فوق بعض
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    dir: 'rtl',
    lang: 'ar',
    // مش بنستخدم '/' كقيمة افتراضية هنا لأن الموقع لو منشور على GitHub
    // Pages كـ project page بيبقى تحت مسار فرعي (مثلاً /repo-name/)، مش
    // على جذر الدومين. self.registration.scope بيرجع المسار الصحيح دايمًا.
    data: { url: data.url || self.registration.scope },
    requireInteraction: false
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

// لما يدوس على الإشعار نفسه، يفتحله الداشبورد (أو يركّز على التاب المفتوح لو موجود بالفعل)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || self.registration.scope;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      for (const client of clientsArr) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
