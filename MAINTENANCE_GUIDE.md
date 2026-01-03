# מדריך תחזוקה אוטומטית - WhatsApp Bot

## 🔧 תכונות שנוספו למניעת נפילת השירות

### 1. **Auto-Reconnect (התחברות מחדש אוטומטית)**
כאשר WhatsApp מתנתק, הבוט אוטומטית מנסה להתחבר מחדש אחרי 5 שניות.

```javascript
// קוד: index.js שורות 214-227
client.on('disconnected', (reason) => {
    // מחכה 5 שניות ומאתחל מחדש
});
```

### 2. **Periodic Health Check (בדיקת בריאות תקופתית)**
כל 5 דקות, הבוט בודק את כל הסשנים:
- אם סשן תקוע יותר מ-10 דקות - מאתחל אוטומטית
- אם סשן לא מגיב - מאתחל אוטומטית
- שולח "ping" לשמור על החיבור פעיל

```javascript
// קוד: index.js שורות 238-264
setInterval(async () => {
    // בודק כל סשן ומאתחל אם צריך
}, 5 * 60 * 1000);
```

### 3. **Watchdog Timer (שומר זמן)**
אם הבוט תקוע ב-99% loading יותר מ-3 דקות - מאתחל אוטומטית.

```javascript
// קוד: index.js שורות 132-144
setTimeout(async () => {
    if (s && (s.status.startsWith('LOADING') || s.status === 'INITIALIZING')) {
        // מאתחל מחדש
    }
}, 180000); // 3 דקות
```

### 4. **Docker Health Check**
Docker בודק כל 2 דקות אם ה-API מגיב:
- אם 3 בדיקות נכשלות ברצף - Docker מאתחל את הקונטיינר

```yaml
# docker-compose.yml
healthcheck:
  test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3000/api/health"]
  interval: 2m
  timeout: 10s
  retries: 3
```

---

## 📡 API Endpoints חדשים

### 1. `/api/health` - בדיקת בריאות כללית
```bash
GET http://localhost:3000/api/health
```

**תשובה:**
```json
{
  "status": "ok",
  "message": "WhatsApp Bot is running",
  "timestamp": "2026-01-03T09:23:16.900Z",
  "sessions": 2
}
```

### 2. `/api/session-health/:sessionId` - בדיקת בריאות לסשן ספציפי
```bash
GET http://localhost:3000/api/session-health/default
```

**תשובה (בריא):**
```json
{
  "healthy": true,
  "status": "READY",
  "sessionId": "default",
  "uptime": 3600000
}
```

**תשובה (לא בריא):**
```json
{
  "healthy": false,
  "status": "DISCONNECTED",
  "sessionId": "default"
}
```

---

## 🚀 שימוש ב-n8n

### דוגמה: בדיקת בריאות לפני שליחת הודעה

1. **HTTP Request Node #1** - בדיקת בריאות:
   - Method: `GET`
   - URL: `http://whatsapp-bot:3000/api/session-health/default`

2. **IF Node** - בדיקה אם בריא:
   - Condition: `{{ $json.healthy }} === true`

3. **HTTP Request Node #2** - שליחת הודעה (רק אם בריא):
   - Method: `POST`
   - URL: `http://whatsapp-bot:3000/api/send-message`
   - Body:
   ```json
   {
     "to": "972501234567",
     "message": "הודעה מ-n8n",
     "sessionId": "default"
   }
   ```

---

## 🔍 מעקב אחר לוגים

### צפייה בלוגים של סשן ספציפי:
```bash
# בתוך הקונטיינר
docker exec whatsapp-bot cat /app/logs/session-default.log

# או דרך API
curl http://localhost:3000/api/logs?sessionId=default
```

### צפייה בלוגים של Docker:
```bash
docker logs whatsapp-bot --tail 50 -f
```

---

## ⚙️ הגדרות מומלצות

### זמני Timeout:
- **Auto-reconnect**: 5 שניות (ניתן לשנות בקוד)
- **Health check interval**: 5 דקות (ניתן לשנות בקוד)
- **Watchdog timer**: 3 דקות (ניתן לשנות בקוד)
- **Docker healthcheck**: 2 דקות (ניתן לשנות ב-docker-compose.yml)

### שינוי זמן Health Check:
```javascript
// index.js - שורה 264
}, 5 * 60 * 1000); // שנה ל-3 דקות: 3 * 60 * 1000
```

### שינוי זמן Docker Healthcheck:
```yaml
# docker-compose.yml
healthcheck:
  interval: 1m  # שנה ל-1 דקה
```

---

## 🛠️ פתרון בעיות

### הבוט עדיין נופל אחרי זמן מסוים:

1. **בדוק את הלוגים**:
   ```bash
   docker logs whatsapp-bot --tail 100
   ```

2. **בדוק את זיכרון הקונטיינר**:
   ```bash
   docker stats whatsapp-bot
   ```

3. **הגדל את זיכרון Docker** (אם צריך):
   ```yaml
   # docker-compose.yml
   whatsapp-bot:
     deploy:
       resources:
         limits:
           memory: 2G
   ```

4. **הקטן את interval של health check** ל-2 דקות במקום 5.

---

## 📊 מעקב אחר סטטיסטיקות

ניתן לראות סטטיסטיקות בממשק הניהול:
```
http://localhost:3000
```

או דרך API:
```bash
curl http://localhost:3000/api/stats
```

---

## 🔄 עדכון השינויים

לאחר שמירת הקבצים, הרץ:
```bash
docker-compose restart whatsapp-bot
```

או rebuild מלא:
```bash
docker-compose up -d --build whatsapp-bot
```

---

## ✅ סיכום

עם השינויים האלה, הבוט אמור להישאר זמין 24/7 ללא צורך בהתערבות ידנית:

✅ התחברות מחדש אוטומטית בניתוק  
✅ בדיקת בריאות כל 5 דקות  
✅ אתחול אוטומטי של סשנים תקועים  
✅ Docker healthcheck  
✅ Watchdog timer למניעת תקיעות  
✅ Restart policy ב-Docker  

**הבוט שלך עכשיו עמיד ואוטונומי! 🚀**
