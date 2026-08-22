// Lola — functions/index.js
// Firebase Cloud Function: generateDnrInsight
//
// الغرض: بروكسي سيرفري بس بين الـ frontend (Static على GitHub Pages) وبين
// Gemini API. الفرونت إند بيبعت أرقام deterministic جاهزة (متوسط فترة،
// انحراف معياري، أكتر يوم، نسب التاجات) — والفانكشن دي بس بتحولها لجملة
// عربية طبيعية. الفانكشن ميعملش أي تحليل أو استنتاج نمط بنفسه؛ ده شغل
// الكود اللي في index.html (habitAdherence / computeIntervalStats / إلخ).
//
// ليه محتاجينها أصلاً: GitHub Pages static بالكامل، يعني مفيش مكان تحط
// فيه الـ Gemini API key بأمان على المتصفح — أي string جوه JS بيتشاف من
// DevTools. الحل: الـ key يتحط هنا بس (سيرفر Firebase)، والـ frontend
// ينادي الـ endpoint ده بدل ما ينادي Gemini مباشرة.

const {onRequest} = require('firebase-functions/v2/https');
const {GoogleGenerativeAI} = require('@google/generative-ai');
const cors = require('cors')({origin: true});

// الـ API key بييجي من Firebase Secret Manager (شوف تعليمات الـ deploy في
// DEPLOY.md) — مش مكتوب هنا كنص صريح عشان ميترفعش على GitHub بالغلط.
const GEMINI_API_KEY = "AQ.Ab8RN6JgzK31WoFVKDx7Ep9ORxApcb-0If2IMKoDhP6Ev9RjGQ";
// كلمات ممنوعة من مخرجات النموذج — أي جملة فيها كلمة من دول بترفض ومنعرضهاش،
// عشان نضمن إن الـ NLG تفضل "وصف نمط" مش "حكم/تشخيص/نصيحة طبية".
const BANNED_WORDS = ['مرض', 'اضطراب', 'خطير', 'تشخيص', 'علاج طبي', 'إدمان مزمن', 'فاشل', 'ضعيف الإرادة'];

function buildPrompt(stats){
  const {n, avgIntervalDays, stdDevDays, topDay, topDayPct, tagCounts, taggedN} = stats;

  let tagLine = 'مفيش بيانات تاجينج كافية.';
  if(tagCounts && taggedN){
    const parts = Object.entries(tagCounts)
      .filter(([,c]) => c > 0)
      .sort((a,b) => b[1]-a[1])
      .map(([tag,c]) => `${tag}: ${c}/${taggedN}`);
    if(parts.length) tagLine = parts.join('، ');
  }

  return `أنت مساعد بتحول أرقام إحصائية جاهزة (مش خام) لجملة عربية واحدة قصيرة، ودّية، وواقعية — من غير أي تشخيص طبي أو حكم على الشخص.

قواعد صارمة:
- استخدم الأرقام المعطاة بالظبط، ما تخترعش رقم جديد.
- سطر أو سطرين بالكتير: جملة "لاحظنا نمط" + اقتراح عملي واحد بسيط.
- ممنوع كلمات زي: تشخيص، مرض، اضطراب، خطير، فاشل، ضعيف الإرادة.
- متقولش "لازم" أو تدي أمر طبي — استخدم "يمكن يفيدك" أو "جرب".
- اكتب باللهجة المصرية العامية الودودة.

الأرقام:
- عدد الحالات المسجّلة في الفترة: ${n}
- متوسط الفترة بين الحالات: ${avgIntervalDays ?? 'غير متاح'} يوم
- الانحراف المعياري: ${stdDevDays ?? 'غير متاح'}
- أكتر يوم في الأسبوع تتكرر فيه الحالة: ${topDay ?? 'غير متاح'} (${topDayPct ?? '—'}% من الحالات)
- التاجات المرتبطة (لو متاحة): ${tagLine}

اكتب الجملة دلوقتي، من غير مقدمة ولا علامات تنصيص.`;
}

exports.generateDnrInsight = onRequest(
  {secrets: [GEMINI_API_KEY], cors: true, region: 'us-central1'},
  async (req, res) => {
    cors(req, res, async () => {
      if(req.method !== 'POST'){
        res.status(405).json({error: 'POST only'});
        return;
      }

      const stats = req.body || {};
      // مفيش استدعاء للنموذج أصلًا لو العينة أقل من 5 — نفس القاعدة اللي
      // في الفرونت إند، بس متكررة هنا كتحقق سيرفري (الفرونت إند ممكن
      // يتعدّل أو يتلعب فيه، الفانكشن هي خط الدفاع الحقيقي).
      if(!stats.n || stats.n < 5){
        res.status(400).json({error: 'insufficient_sample', message: 'العينة أقل من 5 حالات — مفيش استنتاج نمط.'});
        return;
      }

      try{const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({model: 'gemini-2.0-flash'});
        const prompt = buildPrompt(stats);
        const result = await model.generateContent(prompt);
        let text = (result.response.text() || '').trim();

        const hasBanned = BANNED_WORDS.some(w => text.includes(w));
        if(hasBanned || !text){
          // fallback نصّي ثابت بدل ما نعرض جملة فيها كلمة ممنوعة
          text = `لاحظنا نمط في الفترة اللي فاتت — متوسط كل ${stats.avgIntervalDays ?? '—'} يوم تقريبًا، وأكتر يوم بيتكرر فيه هو ${stats.topDay ?? '—'}. يمكن يفيدك تجهّز خطة بديلة قبل اليوم ده بيوم.`;
        }

        res.status(200).json({insight: text});
      }catch(err){
        console.error('generateDnrInsight error:', err);
        res.status(500).json({error: 'generation_failed'});
      }
    });
  }
);
