const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const messaging = admin.messaging();

// نفس تسميات الحالة الموجودة بتطبيق فلاتر - خليها متطابقة معاه دائماً
const STATUS_LABELS = {
  NEW: 'تم استلام طلبك',
  PREPARING: 'طلبك قيد التجهيز',
  READY_FOR_DELIVERY: 'طلبك جاهز للتوصيل',
  ON_THE_WAY: 'طلبك بالطريق إليك',
  DELIVERED: 'تم تسليم طلبك بنجاح',
  CANCELED: 'تم إلغاء طلبك',
};

const TRACK_ENDPOINT = 'https://vanillabelle.store/api/v1/orders/track';

async function checkOrder(doc) {
  const data = doc.data();
  const { trackingCode, trackingPassword, fcmToken, lastKnownStatus } = data;

  try {
    const response = await fetch(TRACK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackingCode, trackingPassword }),
    });
    const json = await response.json();

    if (!json.ok) {
      console.log(`⚠️  ${trackingCode}: فشل الفحص من السيرفر`);
      return;
    }

    const freshStatus = json.data.status;

    // ⭐ بعد الإصلاح، كل مستند يبدأ دايماً بـ lastKnownStatus = 'NEW' من
    // التطبيق نفسه وقت التسجيل - فما نحتاج استثناء "أول فحص" بعد الآن.
    // لو بالصدفة توجد وثيقة قديمة بدون هذا الحقل (قبل الإصلاح)، المقارنة
    // تفشل تلقائياً وترسل إشعار - أأمن بكثير من السكوت الكامل
    if (freshStatus === lastKnownStatus) {
      console.log(`✓  ${trackingCode}: بدون تغيير (${freshStatus})`);
      return;
    }

    // ⭐ الحالة تغيّرت - نرسل إشعار حقيقي
    const label = STATUS_LABELS[freshStatus] || freshStatus;
    await messaging.send({
      token: fcmToken,
      notification: {
        title: 'تحديث حالة طلبك',
        body: `${trackingCode}: ${label}`,
      },
      android: { priority: 'high' },
      apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
    });
    console.log(`🔔 ${trackingCode}: أُرسل إشعار (${lastKnownStatus} → ${freshStatus})`);

    if (freshStatus === 'DELIVERED' || freshStatus === 'CANCELED') {
      // الطلب خلص دوره - نحذفه، ما نبي نبقى نفحصه للأبد
      await doc.ref.delete();
      console.log(`🗑️  ${trackingCode}: انحذف (وصل حالة نهائية)`);
    } else {
      await doc.ref.update({ lastKnownStatus: freshStatus });
    }
  } catch (e) {
    // رمز جهاز غير صالح (التطبيق انحذف مثلاً) - ننظّف المستند
    if (e.code === 'messaging/registration-token-not-registered') {
      await doc.ref.delete();
      console.log(`🗑️  ${trackingCode}: رمز جهاز غير صالح، انحذف`);
      return;
    }
    console.error(`❌ ${trackingCode}: خطأ - ${e.message}`);
  }
}

async function main() {
  const snapshot = await db.collection('device_tokens').get();
  console.log(`🔍 فحص ${snapshot.size} طلب نشط...`);
  await Promise.all(snapshot.docs.map(checkOrder));
  console.log('✅ انتهى الفحص');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('فشل عام بالسكربت:', e);
    process.exit(1);
  });