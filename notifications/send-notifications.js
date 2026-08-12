// Lola — send-notifications.js
// Runs on a schedule (every ~15 min, via GitHub Actions). Each run:
//   1. Works out the current time in Cairo (handles Egypt's DST automatically
//      via the IANA 'Africa/Cairo' zone — no manual clock-change maintenance).
//   2. Checks whether we're inside one of the daily reminder windows.
//   3. Skips it if that reminder was already sent today (dedupe), so running
//      every 15 min doesn't send the same message multiple times in an hour.
//   4. Sends the due reminder (if any) to every subscribed device via Web Push.

const webpush = require('web-push');
const admin = require('firebase-admin');

const REMINDERS = [
  { id: 'breakfast',     hour: 15, minute: 0, title: 'Lola — الفطار 🍳',      body: 'سجّلت فطارك النهاردة؟ افتح Lola وحدّث بناء الوجبات.' },
  { id: 'lunch_workout', hour: 21, minute: 0, title: 'Lola — الغدا والتمرين 🏋', body: 'اتابعت الغدا والتمرين؟ متنساش تعلّم العادات في الداشبورد.' },
  { id: 'dinner_meds',   hour: 1,  minute: 0, title: 'Lola — العشا والدوا 💊',  body: 'قبل ما تنام: سجّلت العشا وأخدت الدوا؟' },
  { id: 'water_1',       hour: 10, minute: 0, title: 'Lola — ميه 💧',          body: 'وقت كوباية ميه — متنساش تشرب.' },
  { id: 'water_2',       hour: 13, minute: 0, title: 'Lola — ميه 💧',          body: 'كوباية ميه دلوقتي كويسة.' },
  { id: 'water_3',       hour: 17, minute: 0, title: 'Lola — ميه 💧',          body: 'فاكر تشرب ميه؟ خد كوباية.' },
  { id: 'water_4',       hour: 20, minute: 0, title: 'Lola — ميه 💧',          body: 'كوباية ميه قبل العشا.' }
];

// كانت 20 دقيقة قبل كده. الـ cron الداخلي بتاع GitHub Actions مش مضمون
// يشتغل بالظبط في وقته — ممكن يتأخر (خصوصًا قرب بداية الساعة، ده معروف من
// GitHub نفسها)، فلو التأخير أكتر من 20 دقيقة كان التنبيه بيتفوّت خالص
// (مش بيتأخر، بيتلغي للنهاردة كلها). رفعها هنا لـ 45 بيدّي هامش أكبر عشان
// التنبيه يوصل حتى لو الـ cron اتأخر، بدل ما يضيع تمامًا.
const WINDOW_MINUTES = 45;

async function main(){
  // ---- Firebase Admin (service account comes from a GitHub secret as JSON text) ----
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  webpush.setVapidDetails(
    'mailto:lola-app@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const docRef = db.collection('shared').doc('nadir_dashboard_v1');
  const snap = await docRef.get();
  if(!snap.exists){ console.log('No shared doc found — nothing to do.'); return; }
  const store = snap.data();

  const subs = store.pushSubscriptions || [];
  if(subs.length === 0){ console.log('No subscribed devices yet.'); return; }

  // current time in Cairo, DST-safe
  const now = new Date();
  const cairoParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Cairo', hour12:false, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'
  }).formatToParts(now).reduce((acc,p)=>{ acc[p.type]=p.value; return acc; }, {});
  const cairoDateStr = `${cairoParts.year}-${cairoParts.month}-${cairoParts.day}`;
  const cairoMinutesOfDay = (+cairoParts.hour)*60 + (+cairoParts.minute);

  const lastSent = store.pushLastSent || {};

  for(const r of REMINDERS){
    const targetMinutes = r.hour*60 + r.minute;
    const diff = cairoMinutesOfDay - targetMinutes;
    const inWindow = diff >= 0 && diff < WINDOW_MINUTES;
    const alreadySentToday = lastSent[r.id] === cairoDateStr;

    if(!inWindow || alreadySentToday) continue;

    console.log(`Sending "${r.id}" to ${subs.length} device(s)...`);
    // مبعتش url هنا خالص — بنسيب الـ service worker (sw.js) يحدد الرابط
    // بنفسه بـ self.registration.scope، عشان يشتغل صح سواء الموقع منشور
    // على جذر الدومين أو تحت مسار فرعي زي GitHub Pages project page.
    const payload = JSON.stringify({ title: r.title, body: r.body, tag: 'lola-'+r.id });

    const stillValid = [];
    for(const sub of subs){
      try{
        await webpush.sendNotification(sub, payload);
        stillValid.push(sub);
      }catch(err){
        if(err.statusCode === 410 || err.statusCode === 404){
          console.log('Subscription expired, dropping it:', sub.endpoint);
          // not pushed to stillValid → gets cleaned up below
        } else {
          console.error('Push failed for one device:', err.message);
          stillValid.push(sub); // keep it, might be a transient error
        }
      }
    }

    // write back: dedupe flag + any expired subscriptions removed
    await docRef.update({
      [`pushLastSent.${r.id}`]: cairoDateStr,
      pushSubscriptions: stillValid
    });

    console.log(`Done: "${r.id}" sent.`);
  }

  console.log('Run complete. Cairo time:', cairoParts, 'minutesOfDay:', cairoMinutesOfDay);
}

main().catch(err=>{
  console.error('Fatal error:', err);
  process.exit(1);
});
