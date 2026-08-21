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

// نفس ترتيب وأسماء أيام الجيم الموجودة في index.html (GYM_DAY_ORDER / GYM_DAYS).
// لو عدّلت الأسماء هناك، لازم تعدّلها هنا برضو عشان الرسالة تفضل مطابقة.
const GYM_DAY_LABELS = {
  push:  'PUSH (صدر - تراي)',
  pull:  'PULL (ضهر - باي - كتف)',
  legs:  'LEGS (رجلين)',
  upper: 'UPPER (الجزء العلوي كامل)',
  lower: 'LOWER (رجلين + كور)'
};
const GYM_REST_DAYS = ['rest1', 'rest2'];

// بيتحدد وقته وكل تفاصيله وقت التشغيل (مش هنا ثابت) لأنه محتاج يقرأ
// store.gym.day الأول عشان يعرف يقول إيه بالظبط.
//
// ملحوظة عن الرابط: بنستخدم './?tab=gym' (نسبي) مش '/?tab=gym' (مطلق) —
// لو استخدمنا مطلق هيرجع نفس مشكلة الـ 404 اللي حصلت قبل كده على GitHub
// Pages project pages (اللي بتكون تحت مسار فرعي زي /repo-name/ مش جذر
// الدومين). sw.js بيحل الرابط النسبي ده بالنسبة لمكانه هو، فبيوصل صح.
function buildGymReminders(store){
  const day = store.gym && store.gym.day;
  const isRest = GYM_REST_DAYS.includes(day);
  if(isRest){
    // يوم راحة: تنبيه الـ12 بالليل بس (مفيش داعي نفكّره الساعة 6 بتمرين مش موجود).
    return [
      { id:'gym_day', hour:0, minute:0, title:'Lola — خد راحتك النهاردة 🌙', body:'النهاردة يوم راحة في جدولك، مفيش داعي تحمّل جسمك أكتر من طاقته. ارتاح وانت مرتاح البال.' }
    ];
  }
  const label = GYM_DAY_LABELS[day];
  const bodyLabel = label ? `تمرين ${label}` : 'تمرين النهاردة';
  return [
    {
      id:'gym_day', hour:0, minute:0,
      title:'Lola — يلا بينا 💪',
      body: `فاكرك جاهز لـ${bodyLabel} النهاردة — خد بالك من نفسك وانت بتلعب.`,
      url:'./?tab=gym'
    },
    {
      // نفس تمرين اليوم، تذكير تاني الساعة 6 مساءً قبل ما اليوم يخلص.
      id:'gym_evening', hour:18, minute:0,
      title:'Lola — لسه فيه وقت 💪',
      body: `لو لسه مسجّلتش ${bodyLabel}، اليوم لسه فيه وقت. وإن كنت خلصت بالفعل، عاش يا وحش 🙌`,
      url:'./?tab=gym'
    }
  ];
}

const REMINDERS = [
  { id: 'breakfast',     hour: 15, minute: 0,  title: 'Lola — فطارك جاهز؟ 🍳',    body: 'فطرت النهاردة ولا لسه؟ سجّله في بناء الوجبات عشان أقدر أطمّن عليك صح.' },
  { id: 'dinner_meds',   hour: 1,  minute: 0,  title: 'Lola — قبل ما تنام 💊',     body: 'قبل ما تسيب نفسك تنام، خد بالك من العشا والدوا الأول — صحتك أهم حاجة عندي.' },
  { id: 'teeth_wake',    hour: 14, minute: 30, title: 'Lola — صباح الخير عليك ☀️', body: 'أول ما تصحى، فرشاة أسنان سريعة وابدأ يومك بشوية نظافة وحنية لنفسك.', url:'./?tab=track' },
  { id: 'water_1',       hour: 10, minute: 0,  title: 'Lola — كوباية ميه 💧',      body: 'متنساش تشرب ميه دلوقتي، جسمك محتاجها.' },
  { id: 'water_2',       hour: 13, minute: 0,  title: 'Lola — ميه تاني 💧',        body: 'كوباية ميه دلوقتي هتفرق معاك، اشرب وانت مرتاح.' },
  { id: 'teeth_sleep',   hour: 2,  minute: 30, title: 'Lola — قبل ما تنام 🪥',     body: 'اقفل يومك بفرشاة أسنان — دلّل نفسك شوية قبل النوم، أسنانك تستاهل الاهتمام ده.', url:'./?tab=track' },
  { id: 'water_3',       hour: 17, minute: 0,  title: 'Lola — ميه 💧',            body: 'فاكر تشرب ميه؟ خد كوباية دلوقتي.' },
  { id: 'water_4',       hour: 20, minute: 0,  title: 'Lola — آخر كوباية ميه 💧',  body: 'كوباية ميه قبل العشا هتساعدك، خدها بحبك.' }
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
  // ملحوظة مهمة: من 12 بليل لحد 12:59، Intl.DateTimeFormat أحيانًا بترجّع
  // الساعة كـ "24" مش "00" (تفصيلة معروفة في بعض إصدارات ICU مع
  // hour12:false). لو سبناها من غير تصحيح، أي تذكير موعده الساعة 0:00
  // (زي تذكير الجيم) مش هيتبعت أبدًا لأن الحساب هيطلع غلط بمقدار يوم
  // كامل (1440 دقيقة). الـ % 1440 هنا بيصلح المشكلة في كل الحالات.
  const cairoMinutesOfDay = ((+cairoParts.hour)*60 + (+cairoParts.minute)) % 1440;

  const allReminders = [...REMINDERS, ...buildGymReminders(store)];

  const testId = (process.env.TEST_REMINDER_ID || '').trim();

  for(const r of allReminders){
    const isTest = testId && r.id === testId;

    if(!isTest){
      const targetMinutes = r.hour*60 + r.minute;
      const diff = cairoMinutesOfDay - targetMinutes;
      const inWindow = diff >= 0 && diff < WINDOW_MINUTES;
      if(!inWindow) continue;
    }

    let claimed = true;
    if(!isTest){
      claimed = await db.runTransaction(async (tx)=>{
        const freshSnap = await tx.get(docRef);
        const freshData = freshSnap.data() || {};
        const freshLastSent = freshData.pushLastSent || {};
        if(freshLastSent[r.id] === cairoDateStr) return false;
        tx.update(docRef, { [`pushLastSent.${r.id}`]: cairoDateStr });
        return true;
      });
    }

    if(!claimed){
      console.log(`Skipping "${r.id}" — already claimed/sent today.`);
      continue;
    }

    console.log(`Sending "${r.id}" to ${subs.length} device(s)...`);
    const payload = JSON.stringify({
      title: r.title, body: r.body, tag: 'lola-'+r.id,
      ...(r.url ? { url: r.url } : {})
    });

    const stillValid = [];
    for(const sub of subs){
      try{
        await webpush.sendNotification(sub, payload);
        stillValid.push(sub);
      }catch(err){
        if(err.statusCode === 410 || err.statusCode === 404){
          console.log('Subscription expired, dropping it:', sub.endpoint);
        } else {
          console.error('Push failed for one device:', err.message);
          stillValid.push(sub);
        }
      }
    }

    await docRef.update({ pushSubscriptions: stillValid });

    console.log(`Done: "${r.id}" sent.`);
  }

  console.log('Run complete. Cairo time:', cairoParts, 'minutesOfDay:', cairoMinutesOfDay);
}

main().catch(err=>{
  console.error('Fatal error:', err);
  process.exit(1);
});
