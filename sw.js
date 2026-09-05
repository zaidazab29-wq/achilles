// Lola — Service Worker
// يفضل شغال في خلفية المتصفح حتى لو قفلت التاب خالص.
// مسؤوليتين هنا:
// 1) يستقبل push event لما السيرفر يبعت إشعار (3 تذكيرات يومية عن طريق VAPID + GitHub Actions)، ويعرضه.
// 2) يدير الضغط على أي إشعار — بما فيه إشعارات "التذكيرات" المحلية (IndexedDB) اللي ليها أزرار Done/Snooze.

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
    // بنمرّر reminderId لو موجود عشان زرار "تم"/"أجل" يعرف يلاقي التذكير في
    // IndexedDB لما يتضغط (شوف notificationclick تحت).
    data: { url: data.url || self.registration.scope, reminderId: data.reminderId },
    // بنسيبها زي ما كانت (false) افتراضيًا للتذكيرات اليومية الثابتة، لكن
    // تذكيرات الـ reminder modal المخصصة بتيجي مع requireInteraction:true
    // من send-notifications.js عشان تفضل ظاهرة لحد ما المستخدم يتعامل معاها.
    requireInteraction: !!data.requireInteraction
  };
  // أزرار "تم"/"أجل 10 دقايق" لو السيرفر بعتها (تذكيرات مخصصة بس — التذكيرات
  // اليومية الثابتة مالهاش أزرار). notificationclick تحت بيتعرف عليها من
  // الـ tag اللي بادئ بـ 'reminder-' زي بالظبط لما التاب نفسه يبعت الإشعار.
  if(Array.isArray(data.actions) && data.actions.length) options.actions = data.actions;

  event.waitUntil(self.registration.showNotification(data.title, options));
});

/* ======================================================================
   ميزة "التذكيرات" (IndexedDB محلي، مفيهاش أي سيرفر)
   بتشتغل على نفس الداتابيز اللي الصفحة الرئيسية بتفتحها.
   ====================================================================== */

const REM_DB_NAME = 'lola_reminders_db';
const REM_DB_VERSION = 1;
const REM_STORE = 'reminders';

function remOpenDB(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(REM_DB_NAME, REM_DB_VERSION);
    req.onupgradeneeded = (e)=>{
      const db = e.target.result;
      if(!db.objectStoreNames.contains(REM_STORE)){
        db.createObjectStore(REM_STORE, {keyPath:'id', autoIncrement:true});
      }
    };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
  });
}
function remGet(id){
  return remOpenDB().then(db=>new Promise((resolve, reject)=>{
    const tx = db.transaction(REM_STORE, 'readonly');
    const req = tx.objectStore(REM_STORE).get(id);
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
  }));
}
function remPut(reminder){
  return remOpenDB().then(db=>new Promise((resolve, reject)=>{
    const tx = db.transaction(REM_STORE, 'readwrite');
    const req = tx.objectStore(REM_STORE).put(reminder);
    req.onsuccess = ()=>resolve();
    req.onerror = ()=>reject(req.error);
  }));
}
async function remNotifyClientsChanged(){
  const clientsList = await self.clients.matchAll({type:'window'});
  clientsList.forEach(c=>c.postMessage({type:'reminders-changed'}));
}

// لما يدوس على أي إشعار — بيتفرّع هنا حسب الـ tag:
// - tag يبدأ بـ 'reminder-' → منطق التذكيرات (Done / Snooze / فتح التطبيق)
// - أي حاجة تانية (زي إشعارات الـ push العامة) → focus/open التاب زي ما كان
self.addEventListener('notificationclick', (event) => {
  const tag = event.notification.tag || '';

  if (tag.startsWith('reminder-')) {
    const id = Number(tag.replace('reminder-', ''));
    event.notification.close();

    if (event.action === 'done') {
      event.waitUntil((async () => {
        const r = await remGet(id);
        if (r) { r.done = true; await remPut(r); }
        await remNotifyClientsChanged();
      })());
      return;
    }

    if (event.action === 'snooze') {
      event.waitUntil((async () => {
        const r = await remGet(id);
        if (r) {
          r.due = Date.now() + 10 * 60 * 1000; // + 10 دقايق
          await remPut(r);
        }
        await remNotifyClientsChanged();
        // ملحوظة: التذكير المؤجل هيتبعت بس لو فيه تاب/نافذة فاتحة للتطبيق
        // (حتى في الخلفية) خلال الـ 10 دقايق دي، لأن مفيش سيرفر يبعت
        // push حقيقي وقتها — قيد من منصة المتصفحات مش حاجة تتحل بكود.
      })());
      return;
    }

    // ضغطة على جسم الإشعار نفسه (مش على زرار) — افتح/فوكس التطبيق
    event.waitUntil((async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of allClients) {
        if ('focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(self.registration.scope);
    })());
    return;
  }

  // إشعار عادي (مش تذكير) — نفس منطق الـ push الأساسي: افتح الداشبورد
  // أو فوكس على التاب المفتوح لو موجود بالفعل
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
