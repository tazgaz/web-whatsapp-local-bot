# מדריך להתקנה על Raspberry Pi (Docker + n8n) 🥧

קובץ זה מכיל את ההוראות להרצת הבוט ומערכת n8n על Raspberry Pi באמצעות Docker.

## דרישות קדם
- Raspberry Pi 4 ומעלה (מומלץ 4GB RAM).
- מערכת הפעלה Raspberry Pi OS (64-bit מומלץ).
- חיבור לאינטרנט.

---

## שלב 1: התקנת Docker ו-Docker Compose
הערה: אם כבר מותקן אצלך Docker, ניתן לדלג לשלב 2.

פתח טרמינל ב-Raspberry Pi והרץ:
```bash
# 1. התקנת Docker
curl -sSL https://get.docker.com | sh

# 2. הוספת המשתמש לקבוצת Docker (מאפשר הרצה ללא sudo)
sudo usermod -aG docker $USER

# 3. התקנת Docker Compose
sudo apt-get update
sudo apt-get install -y docker-compose
```
**חשוב:** יש לבצע הפעלה מחדש (Restart) ל-Pi לאחר פקודות אלו.

---

## שלב 2: העברת הקבצים
העבר את כל תיקיית הפרויקט לראסברי פיי. וודא שהקבצים הבאים קיימים בתיקייה:
- `Dockerfile`
- `docker-compose.yml`
- `index.js`, `messageHandler.js`, `public/` וכו'.

---

## שלב 3: הרצת המערכת
כנס לתיקיית הפרויקט בטרמינל והרץ:
```bash
docker-compose up -d
```
הפקודה תבנה את הסביבה ותפעיל שני שירותים:
1. **whatsapp-bot**: הבוט שלך (פורט 3000).
2. **n8n**: מערכת האוטומציה (פורט 5678).

---

## שלב 4: גישה לממשקים
פתח את הדפדפן במחשב שלך (באותה רשת) והכנס לכתובות הבאות:

- **ממשק ניהול הבוט (לסריקת QR):**
  `http://[כתובת-ה-IP-של-ה-Pi]:3000`

- **ממשק n8n:**
  `http://[כתובת-ה-IP-של-ה-Pi]:5678`

---

## איך לחבר את הבוט ל-n8n?
1. בתוך **n8n**, צור Workflow חדש והוסף צומת (Node) מסוג **Webhook**.
2. העתק את הכתובת של ה-Webhook.
3. בממשק הניהול של הבוט (פורט 3000), הוסף כלל חדש.
4. בשדה ה-**Webhook URL**, הדבק את הכתובת. 
   *טיפ: מכיוון ששניהם רצים בתוך Docker, ניתן להחליף את ה-IP במילה `n8n`.*
   דוגמה: `http://n8n:5678/webhook/your-id`

---

## תחזוקה
- **צפייה בלוגים:** `docker-compose logs -f`
- **עצירת המערכת:** `docker-compose down`
- **עדכון קוד:** לאחר שינוי קוד, הרץ `docker-compose up -d --build`
