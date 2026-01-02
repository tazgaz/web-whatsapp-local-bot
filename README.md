# 🤖 Shargo WhatsApp Bot | Hub & Analytics

מערכת Enterprise לניהול אוטומציות וואטסאפ מרובות חשבונות, הכוללת ממשק ניהול בסטנדרט גבוה, דשבורד אנליטיקה חכם, ותמיכה מלאה ב-Webhooks ואוטומציות מורכבות.

---

## 🖼️ מבט על המערכת

### 📊 דשבורד אנליטיקה (לפי חשבון)
![Dashboard](./docs/images/dashboard.png)

### ⚙️ ניהול אוטומציות וחוקים
![Automation](./docs/images/automation.png)

### 📜 יומן פעילות חי
![Logs](./docs/images/logs.png)

---

## ✨ מה חדש בגירסה זו (v2.0)

- 👥 **תמיכה בריבוי חשבונות (Multi-Session)**: ניהול מספר חשבונות וואטסאפ במקביל מממשק אחד.
- 📈 **דשבורד אנליטיקה פר-חשבון**: צפייה בנתונים סטטיסטיים (כמות הודעות, אחוזי הצלחה, חוקים פופולריים) עבור כל חשבון בנפרד.
- 🌐 **ממשק Cyber-Tech / Glassmorphism**: עיצוב מודרני מרהיב המבוסס על שפת המותג של Shargo.
- 🛡️ **אבטחה משופרת**: מנגנוני אישור למחיקת חשבונות, שמירה אוטומטית של לוגים לקבצים, וניהול מצבי משתמש מתקדם.
- 🚀 **Watchdog מובנה**: מערכת ניטור שמתניעה מחדש חשבונות שנתקעו בזמן טעינה.

---

## 🚀 התקנה מהירה

### דרישות קדם
- [Docker](https://www.docker.com/) & [Docker Compose](https://docs.docker.com/compose/)

### שלבי הרצה
1. שכפל את המאגר:
   ```bash
   git clone https://github.com/tazgaz/web-whatsapp-local-bot.git
   cd web-whatsapp-local-bot
   ```

2. הרץ את המכולות:
   ```bash
   docker-compose up -d --build
   ```

3. פתח את הממשק בדפדפן:
   `http://localhost:3000`

---

## 🛠️ טכנולוגיות
- **Core**: Node.js, Express, Socket.io
- **WhatsApp**: [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js)
- **UI/UX**: Vanilla JavaScript, CSS Glassmorphism, Chart.js, Lucide Icons
- **Automation Hub**: n8n, Redis
- **Infra**: Docker & Docker Compose

---

## 👨‍💻 פיתוח
פותח על ידי **Antigravity** עבור **Shargo | Experts in Business Automation**.

---

## 📝 רישיון
כל הזכויות שמורות ל-Shargo. לשימוש אישי ופנימי בלבד.
