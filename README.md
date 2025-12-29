# 🤖 WhatsApp Automation Bot & Control Panel

מערכת אוטומציה מתקדמת לוואטסאפ הכוללת ממשק ניהול ידידותי, מענה אוטומטי חכם, תזמון הודעות ותמיכה ב-Webhooks.

---

## ✨ תכונות עיקריות

- 📱 **ממשק ניהול בדפדפן**: ניהול כל ההגדרות דרך לוח בקרה מעוצב ונוח.
- 💬 **מענה אוטומטי חכם**:
  - תמיכה במספר מילות מפתח לכל כלל.
  - סוגי התאמה שונים: מכיל, מדויק, מתחיל ב.., מסתיים ב.. וביטויים רגולריים (Regex).
  - מענה "תפוס הכל" (Catch-all) להודעות שלא תואמות לאף כלל.
- 🎯 **סינון מקורות**: אפשרות להגביל מענה רק למספרים או קבוצות ספציפיים.
- 🔗 **תמיכה ב-Webhooks**: שליחת הודעות נכנסות למערכות חיצוניות (כמו n8n, Make, או שרת משלכם).
- 📅 **תזמון הודעות**: שליחת הודעות בפרקי זמן קבועים (Cron Jobs).
- 🔄 **העברת הודעות (Forwarding)**: העברת הודעות המכילות טריגר מסוים למספר אחר.
- 🐳 **תמיכה ב-Docker**: מוכן להרצה קלה על שרתים או Raspberry Pi.

---

## 🚀 התקנה מהירה (מקומית)

### דרישות קדם
- [Node.js](https://nodejs.org/) (גרסה 18 ומעלה)
- [Git](https://git-scm.com/)

### שלבי התקנה
1. שכפל את המאגר:
   ```bash
   git clone https://github.com/tazgaz/web-whatsapp-local-bot.git
   cd web-whatsapp-local-bot
   ```

2. התקן תלויות:
   ```bash
   npm install
   ```

3. הרץ את האפליקציה:
   ```bash
   node index.js
   ```

4. פתח את הממשק בדפדפן בכתובת:
   `http://localhost:3000`

---

## 🏗️ הרצה על Raspberry Pi / שרת (Docker)

המערכת מגיעה מוכנה להרצה באמצעות Docker ו-Docker Compose, וכוללת תמיכה מובנית ב-**n8n** לאוטומציות מורכבות.

למדריך המלא בעברית להרצה על ה-Pi, ראה: [RASPBERRY_PI_GUIDE.md](./RASPBERRY_PI_GUIDE.md).

---

## 🛠️ טכנולוגיות
- **Backend**: Node.js, Express, Socket.io
- **WhatsApp Library**: [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js)
- **Frontend**: Vanilla JS, CSS3, HTML5
- **Automation**: Docker, n8n Integration

---

## 📝 רישיון
פרויקט זה מיועד לשימוש אישי ולימודי.

---

## 👨‍💻 פיתוח
פותח על ידי Antigravity עבור tazgaz.
