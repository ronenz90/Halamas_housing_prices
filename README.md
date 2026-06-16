# 🏠 מדד מחירי הדירות בישראל — CBS Live Dashboard

דשבורד אינטראקטיבי לנתוני מדד מחירי הדירות מהלמ"ס, עם עדכון אוטומטי.

## 🚀 הפעלה מהירה

### שלב 1 — העלה ל-GitHub
```bash
git init
git add .
git commit -m "🏠 Initial commit"
git remote add origin https://github.com/USERNAME/housing-index.git
git push -u origin main
```

### שלב 2 — הפעל GitHub Pages
1. היכנס ל-Settings → Pages
2. Source: **Deploy from a branch**
3. Branch: **gh-pages** / root
4. שמור

### שלב 3 — הרץ את ה-Action הראשון
1. היכנס ל-Actions → "Update Housing Index Data"
2. לחץ **Run workflow**

האתר יהיה זמין בכתובת:
`https://USERNAME.github.io/housing-index`

---

## 🔄 עדכון אוטומטי

GitHub Actions מריץ את `src/fetch-data.js` שמושך נתונים מ-API של הלמ"ס:
- **כל ה-15 לחודש** בשעה 19:00 (שעון ישראל) — מועד פרסום הלמ"ס
- **ה-16 לחודש** בשעה 09:00 — גיבוי במקרה של עיכוב
- **ידנית** דרך כפתור "Run workflow"

### קודי ה-API בשימוש:
| קוד | מחוז |
|-----|------|
| 40010 | ארצי |
| 60000 | ירושלים |
| 60100 | צפון |
| 60200 | חיפה |
| 60300 | מרכז |
| 60400 | תל אביב |
| 60500 | דרום |

---

## 📊 תכונות

- **נתוני אמת** מ-`api.cbs.gov.il` (API פתוח של הלמ"ס)
- **עדכון אוטומטי** ב-15 לחודש
- **7 מחוזות**: ארצי, ירושלים, צפון, חיפה, מרכז, תל אביב, דרום
- **3 סוגי גרף**: שינוי %, מדד, שינוי שנתי
- **השוואת מחוזות** על גרף אחד
- **ייצוא PDF** עם KPIs + גרפים + טבלה
- **נתונים ארעיים** מסומנים בכוכבית *

---

## 📁 מבנה

```
/
├── index.html          # האפליקציה הראשית
├── data/
│   └── housing.json    # נתוני הלמ"ס (מתעדכן ע"י Actions)
├── src/
│   └── fetch-data.js   # סקריפט משיכת הנתונים
└── .github/workflows/
    └── update-data.yml  # GitHub Actions
```

---

## ⚙️ הגדרות GitHub Actions

הוסף הרשאות ל-Actions:
1. Settings → Actions → General
2. Workflow permissions: **Read and write permissions**

---

## 📝 מקור הנתונים

הלשכה המרכזית לסטטיסטיקה (הלמ"ס) | [api.cbs.gov.il](https://api.cbs.gov.il)

הנתונים מבוססים על עסקאות נדל"ן המדווחות לרשות המיסים.
3 הנתונים האחרונים הם **ארעיים** ועשויים להתעדכן.
