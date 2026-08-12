// Lola — send-notifications.js
// Runs every ~15 min via GitHub Actions. Each run, in Cairo local time
// (DST-safe — computed fresh from the IANA zone, no manual clock updates):
//
//   1. FIXED   — 3 anchored check-ins: فطار (9ص) / غدا وتمرين (3ع) / عشا واطمينان (10م)
//   2. WATER   — 5 reminders every 3h from 1ظ to 1ص: 13:00, 16:00, 19:00, 22:00, 01:00
//   3. RANDOM  — 3-4 warm "just checking on you" pings at random times each day
//                (chosen once, the first run after Cairo midnight, and reused
//                for the rest of that day so every run agrees on the same times)
//
// Every single message — fixed, water, or random — is freshly WRITTEN by
// Gemini using Lola's persona, so nothing ever feels like a copy-pasted
// template. The Gemini API key here is a GitHub secret, never exposed to
// the browser, so there's no key-abuse risk from this call.

const webpush = require('web-push');
const admin = require('firebase-admin');

const GEMINI_MODEL = 'gemini-3.5-flash-lite'; // مناسب لرسائل قصيرة زي دي - سريع ورخيص
const WINDOW_MINUTES = 10; // كافية دلوقتي — الترچر الخارجي بيشتغل كل 5 دقايق

const LOLA_PERSONA = `إنتِ "لولا" — مساعدة شخصية حنينة ودافئة لشاب اسمه زياد بيذاكر طب وبيهتم بلياقته وأكله.
بتتكلمي باللهجة المصرية البسيطة، زي حد قريب منه بجد (مش موظفة، مش روبوت، مش رسمية خالص).
اكتبي رسالة تنبيه قصيرة (سطر أو سطرين بالكتير، أقل من 25 كلمة)، دافئة وطبيعية، من غير أي مقدمات زي "بالطبع" أو "تفضل".
استخدمي إيموجي واحد بس لو مناسب، مش أكتر. ممنوع تكرري نفس الصياغة اللي غالبًا استخدمتيها قبل كده — نوّعي في الأسلوب كل مرة.`;

const FIXED = [
  { id: 'breakfast',     hour: 9,  minute: 0, occasion: 'دلوقتي الصبح — اسأليه سؤال حنين لو فطر النهاردة أو لسه، وشجعيه يبدأ يومه كويس.' },
  { id: 'lunch_workout', hour: 15, minute: 0, occasion: 'دلوقتي بعد الضهر — اسأليه لو اتغدى وهو ماشي في التمرين ولا لسه، بشكل مهتم مش مراقب.' },
  { id: 'dinner_meds',   hour: 22, minute: 0, occasion: 'دلوقتي بالليل قبل النوم — اطمّني عليه، اسأليه عن عشاه ولو أخد دوا لو محتاج، وقوليله يبات بخير.' }
];

const WATER_HOURS = [13, 16, 19, 22, 1]; // كل 3 ساعات من 1 الضهر لـ1 بعد نص الليل
const WATER = WATER_HOURS.map((h,i) => ({ id: 'water_'+i, hour: h, minute: 0, occasion: 'ذكّريه يشرب كوباية ميه دلوقتي، بجملة خفيفة ومختلفة كل مرة، من غير ما تبقى نصيحة طبية جافة.' }));

const RANDOM_WINDOW = { startHour: 9, endHour: 23, endMinute: 30 }; // من 9 الصبح لـ11:30 بالليل
const RANDOM_COUNT_MIN = 3, RANDOM_COUNT_MAX = 4;
const RANDOM_MIN_GAP_MIN = 45; // أقل مسافة بين وقت عشوائي وأي وقت (تابت أو عشوائي تاني)

function cairoNow(){
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Cairo', hour12:false, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'
  }).formatToParts(now).reduce((acc,p)=>{ acc[p.type]=p.value; return acc; }, {});
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    minutesOfDay: (+parts.hour)*60 + (+parts.minute)
  };
}

function pickRandomTimes(reservedMinutes){
  const count = Math.random() < 0.5 ? RANDOM_COUNT_MIN : RANDOM_COUNT_MAX;
  const chosen = [];
  const windowStart = RANDOM_WINDOW.startHour*60;
  const windowEnd = RANDOM_WINDOW.endHour*60 + RANDOM_WINDOW.endMinute;
  let attempts = 0;
  while(chosen.length < count && attempts < 400){
    attempts++;
    const candidate = windowStart + Math.floor(Math.random() * (windowEnd - windowStart));
    const tooClose = [...reservedMinutes, ...chosen].some(m => Math.abs(m - candidate) < RANDOM_MIN_GAP_MIN);
    if(!tooClose) chosen.push(candidate);
  }
  return chosen.sort((a,b)=>a-b);
}

async function generateLolaMessage(occasion){
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const body = {
    contents: [{ role:'user', parts:[{ text: occasion }] }],
    systemInstruction: { parts:[{ text: LOLA_PERSONA }] },
    generationConfig: { maxOutputTokens: 80 }
  };
  const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if(!res.ok){
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if(!text) throw new Error('Gemini returned no text');
  return text;
}

async function sendToAll(db, docRef, subs, title, body, tag){
  const payload = JSON.stringify({ title, body, tag, url: '/' });
  const stillValid = [];
  for(const sub of subs){
    try{
      await webpush.sendNotification(sub, payload);
      stillValid.push(sub);
    }catch(err){
      if(err.statusCode === 410 || err.statusCode === 404){
        console.log('Subscription expired, dropping it.');
      } else {
        console.error('Push failed for one device:', err.message);
        stillValid.push(sub);
      }
    }
  }
  await docRef.update({ pushSubscriptions: stillValid });
}

async function main(){
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  webpush.setVapidDetails('mailto:lola-app@example.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

  const docRef = db.collection('shared').doc('nadir_dashboard_v1');
  const snap = await docRef.get();
  if(!snap.exists){ console.log('No shared doc found — nothing to do.'); return; }
  const store = snap.data();

  const subs = store.pushSubscriptions || [];
  if(subs.length === 0){ console.log('No subscribed devices yet.'); return; }

  const { dateStr, minutesOfDay } = cairoNow();
  const lastSent = store.pushLastSent || {};

  // ---- make sure today's random times are already picked ----
  let randomPlan = store.lolaRandomPlan;
  if(!randomPlan || randomPlan.date !== dateStr){
    const reserved = [...FIXED, ...WATER].map(r => r.hour*60 + r.minute);
    const times = pickRandomTimes(reserved);
    randomPlan = { date: dateStr, times, sent: [] };
    await docRef.update({ lolaRandomPlan: randomPlan });
    console.log('Picked new random times for today:', times.map(m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`));
  }

  // ---- FIXED + WATER (deduped via pushLastSent, same pattern as before) ----
  for(const r of [...FIXED, ...WATER]){
    const target = r.hour*60 + r.minute;
    const diff = minutesOfDay - target;
    const inWindow = diff >= 0 && diff < WINDOW_MINUTES;
    if(!inWindow || lastSent[r.id] === dateStr) continue;

    console.log(`Generating + sending "${r.id}"...`);
    const text = await generateLolaMessage(r.occasion);
    await sendToAll(db, docRef, subs, 'لولا 💬', text, 'lola-'+r.id);
    await docRef.update({ [`pushLastSent.${r.id}`]: dateStr });
  }

  // ---- RANDOM (deduped via randomPlan.sent, indices already fired today) ----
  for(let i=0;i<randomPlan.times.length;i++){
    const target = randomPlan.times[i];
    const diff = minutesOfDay - target;
    const inWindow = diff >= 0 && diff < WINDOW_MINUTES;
    if(!inWindow || randomPlan.sent.includes(i)) continue;

    console.log(`Generating + sending random check-in #${i}...`);
    const text = await generateLolaMessage('ابعتيله رسالة عشوائية حنينة بتطمني عليه وعلى يومه بشكل عام، من غير ما تكون مرتبطة بوجبة معينة.');
    await sendToAll(db, docRef, subs, 'لولا 💬', text, 'lola-random-'+i);
    randomPlan.sent.push(i);
    await docRef.update({ lolaRandomPlan: randomPlan });
  }

  console.log('Run complete. Cairo minutesOfDay:', minutesOfDay);
}

main().catch(err=>{
  console.error('Fatal error:', err);
  process.exit(1);
});
