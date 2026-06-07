# 译 · Translate — Deployment Guide
## English ↔ Mandarin PWA · Powered by Claude AI

---

## STEP 1 — Create a GitHub Repository

1. Go to https://github.com and sign in
2. Click the **+** button (top right) → **New repository**
3. Name it: `yi-translate`
4. Set to **Public**
5. Leave all other options as default
6. Click **Create repository**

---

## STEP 2 — Upload the Project Files

On the next screen GitHub shows you, look for the link that says:
**"uploading an existing file"** — click it.

Drag the entire contents of the `translator-app` folder into the upload area.
Make sure you upload ALL files and folders including:
- `src/` folder (with `App.jsx` and `main.jsx`)
- `public/` folder (with the icon images)
- `package.json`
- `vite.config.js`
- `netlify.toml`
- `index.html`

Click **Commit changes**.

---

## STEP 3 — Connect Netlify to GitHub

1. Go to https://netlify.com and sign in
2. Click **Add new site** → **Import an existing project**
3. Click **GitHub**
4. Authorise Netlify to access your GitHub (first time only)
5. Find and select your `yi-translate` repository
6. Netlify will auto-detect the build settings from `netlify.toml`:
   - Build command: `npm run build`
   - Publish directory: `dist`
7. Click **Deploy site**

Netlify will build and deploy — takes about 60–90 seconds.
You'll get a URL like: `https://amazing-name-123456.netlify.app`

You can rename it under **Site settings → Site name** to something like `yi-translate`.

---

## STEP 4 — Install on iPhone as a Native App

1. Open the Netlify URL in **Safari** on your iPhone
   (Must be Safari for "Add to Home Screen" to work)
2. Tap the **Share** button (box with arrow pointing up)
3. Scroll down and tap **Add to Home Screen**
4. Name it `译 Translate` → tap **Add**

The app now appears on your home screen with its own icon.
It opens fullscreen with no browser bars — just like a native app.

---

## STEP 5 — Microphone Permission

First time you tap a mic button, iPhone will ask:
**"yi-translate.netlify.app would like to access the microphone"**
→ Tap **Allow**

For Mandarin recognition to work well:
- Go to iPhone **Settings → General → Keyboard → Keyboards**
- Confirm **Simplified Chinese** (or Traditional) is added
- This improves iOS speech recognition accuracy significantly

---

## USING THE APP

**Mic buttons** (bottom of screen)
- Tap the **English** mic → speak → tap again to stop (or it auto-stops)
- Tap the **普通话** mic → speak in Mandarin → tap again to stop
- Translation appears on screen and is spoken aloud automatically

**⌨ Keyboard button** (centre, between mic buttons)
- Opens typed input for both languages when voice isn't practical

**⚙ Settings** (top right)
- Script: Simplified (简) or Traditional (繁)
- Font size: S / M / L / XL
- Pinyin: ON shows tone-marked pinyin below each Chinese exchange
- Auto-speak: ON/OFF for text-to-speech
- Clear conversation

**↑ Export** (top right)
- Text (.txt), HTML (.html), CSV (.csv), or Copy to clipboard
- All exports include pinyin and any flagged exchanges

**⚠ Orange border on an exchange**
- Silent back-translation detected a possible accuracy issue
- Tap 🔊 Replay to hear both sides and verify

---

## FUTURE UPDATES

When I make improvements to the app:
1. I'll provide updated `App.jsx` file
2. You replace the file in your GitHub repository
3. Netlify auto-deploys within 60 seconds
4. App updates on your phone automatically (PWA auto-update)

---

*Built by Claude (Anthropic) for Glen Williams · June 2026*
