# 🤖 SAHIL 804 BOT — v4.0.0

> Pakistan's most powerful WhatsApp Bot SaaS Platform  
> 👑 By **𝑺𝒂𝒉𝒊𝒍 𝑯𝒂𝒄𝒌𝒆𝒓 𝟖𝟎𝟒**

---

## 🚀 Quick Deploy (Railway)

### Step 1 — Clone Repo
```bash
git clone https://github.com/YOUR_USERNAME/sahil-bot-804.git
cd sahil-bot-804
npm install
```

### Step 2 — Firebase Setup
1. Go to [Firebase Console](https://console.firebase.google.com)
2. Open project: `sahilhaccker-bot`
3. Project Settings → Service Accounts
4. **Delete/Revoke** old private key
5. **Generate New Private Key** → download JSON
6. Copy the `private_key` value

### Step 3 — Setup .env
```bash
cp .env.example .env
```
Edit `.env` and fill in:
- `FIREBASE_PRIVATE_KEY` — paste your new private key
- `SESSION_SECRET` — any random long string
- `ADMIN_PASSWORD` — your admin panel password

### Step 4 — Test Locally
```bash
node web/server.js
```
Open: http://localhost:3000

### Step 5 — Push to GitHub
```bash
git add .
git commit -m "Initial deploy"
git push origin main
```

### Step 6 — Deploy on Railway
1. Go to [Railway.app](https://railway.app)
2. New Project → Deploy from GitHub
3. Select your repo
4. Add Environment Variables (copy from `.env`)
5. Deploy → Bot is LIVE ✅

---

## 📁 Project Structure

```
sahil-bot-804/
├── package.json
├── .env.example
├── .gitignore
├── railway.json
├── README.md
├── src/
│   ├── config/
│   │   └── config.js          ← All settings & API keys
│   ├── utils/
│   │   └── helpers.js         ← Logger, cache, session manager, helpers
│   ├── firebase/
│   │   └── config.js          ← Firebase init + ALL DB operations
│   ├── middleware/
│   │   └── auth.js            ← Auth, admin, subscription middleware
│   ├── apis/
│   │   └── downloader.js      ← All external API calls
│   ├── commands/
│   │   └── index.js           ← All 50+ bot commands
│   ├── handlers/
│   │   └── messageHandler.js  ← Message handler + auto-react
│   └── bot/
│       └── launcher.js        ← Baileys bot launcher
└── web/
    ├── server.js              ← Express server + WebSocket + all API routes
    └── public/
        ├── index.html         ← Landing page
        ├── login.html         ← User + Admin login
        ├── register.html      ← User registration
        ├── dashboard.html     ← User dashboard + bot deploy
        └── admin.html         ← Admin panel
```

---

## 🔐 Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default 3000) |
| `SESSION_SECRET` | Express session secret |
| `FIREBASE_PROJECT_ID` | Firebase project ID |
| `FIREBASE_CLIENT_EMAIL` | Firebase service account email |
| `FIREBASE_PRIVATE_KEY` | Firebase private key (with \n) |
| `FIREBASE_DATABASE_URL` | Firebase RTDB URL |
| `RAPIDAPI_KEY` | RapidAPI key for YouTube |
| `ADMIN_EMAIL` | Admin panel email |
| `ADMIN_PASSWORD` | Admin panel password |
| `OWNER_NUMBER` | Owner WhatsApp number |

---

## 🤖 Bot Commands

**General:** `.menu` `.ping` `.alive` `.owner` `.id`  
**Downloads:** `.ytmp3` `.tiktok` `.insta` `.fb`  
**Tools:** `.calc` `.weather` `.wiki` `.define` `.translate` `.short` `.crypto` `.currency` `.sim`  
**Islamic:** `.quran` `.prayer` `.dua` `.hadith` `.hijri`  
**Fun:** `.joke` `.quote` `.shayari` `.attitude` `.pickup` `.fact` `.roast` `.meme`  
**Games:** `.rps` `.dice` `.flip` `.trivia` `.math` `.truth`  
**Group:** `.kick` `.add` `.promote` `.demote` `.mute` `.unmute` `.tagall` `.groupinfo`  
**Mode:** `.public` `.private`  
**Owner:** `.broadcast` `.stats` `.restart`

---

## 👑 Owner Info

- **Name:** 𝑺𝒂𝒉𝒊𝒍 𝑯𝒂𝒄𝒌𝒆𝒓 𝟖𝟎𝟒
- **WhatsApp:** [wa.me/923496049312](https://wa.me/923496049312)
- **Email:** sahilhackerx110@gmail.com
- **Channel:** [Join Here](https://whatsapp.com/channel/0029Vb7ufE7It5rzLqedDc3l)

---

> ⚠️ Never commit `.env` or `serviceAccountKey.json` to GitHub!
