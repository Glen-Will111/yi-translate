# 译 · Translate — Deployment Guide
## English ↔ Chongqing dialect / Mandarin conversation interpreter · Powered by Claude AI

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

## STEP 6 — Keys and (optional) passcode in Netlify

Netlify → your site → **Site configuration → Environment variables**:

| Variable | Needed? | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Required** | Your Claude API key (translation and checking). Stays on Netlify, never on the phone. |
| `OPENAI_API_KEY` | Recommended | Your OpenAI API key, for **OpenAI hearing** (see below). Without it the app uses the iPhone's own hearing and takes turns. |
| `APP_PASSCODE` | Recommended | Any word or number. Without it, anyone who finds the site address can use your keys. Once set, enter the same passcode once in the app under ⚙ → Passcode. |
| `OPENAI_TRANSCRIBE_MODEL` | Optional | Leave unset to use `gpt-4o-transcribe`. Only change it if OpenAI renames or replaces that model. |

After changing variables: **Deploys → Trigger deploy → Deploy site**.

### Getting an OpenAI key
1. Go to https://platform.openai.com and sign in (or create an account).
2. **Settings → Billing**: add a payment method and a small credit (e.g. US$5–10).
   Hearing costs roughly a cent per minute of actual talking. Silence is never sent.
3. **API keys → Create new secret key**. Name it `yi-translate` and copy it.
4. Paste it into Netlify as `OPENAI_API_KEY` (above) and redeploy.
5. In the app, ⚙ Settings → **Hearing** should now say **OpenAI ready ✓**.

---

## STEP 7 — Best iPhone settings for this app

- **Better voices:** Settings → Accessibility → Spoken Content → Voices →
  download an *Enhanced* or *Premium* voice for **Chinese (China mainland)**
  (e.g. Lili or Yu-shu) and **English (Australia)** (e.g. Karen or Lee).
  The app picks Enhanced/Premium voices automatically.
- **Recognition:** Settings → General → Keyboard → add **Chinese, Simplified**
  and make sure **Enable Dictation** is on.
- **Volume:** the side button volume controls the spoken translation. Use the
  loudspeaker, not headphones, so you both hear it.

---

## USING THE APP

### Conversation mode (hands-free)
1. Put the phone between you and Lucy and tap **▶ Start**.
2. **Just talk to each other.** With OpenAI hearing it listens to you both all the
   time and works out who is speaking from the language: English = Glen,
   Chinese = Lucy. No turn-taking needed.
3. When someone pauses, it translates, **checks the translation**, then speaks it.
   Whatever is said while it's translating is queued and handled in order.
4. Tap **■ Stop** when you've finished.

- **Finished talking but it hasn't noticed?** Tap your name to send straight away.
- **The green line under the status** shows the mic level, so you can see it hearing you.
- **Mic deaf while the phone speaks**, so it never translates itself.
- **Screen stays awake** during a conversation.
- **Got the wrong person?** Open "How it was checked" on the card → **⇄ Wrong person?**
- **Background noise or a TV** that gets picked up is shown greyed as "Ignored".
- **Settings that help:** *Mic pickup* (Noisy room / Normal / Quiet voices) and
  *Wait for pause* (Long is good when you're both speaking slowly while learning).

**If anything misbehaves on the day** (e.g. the spoken voice is too quiet while the
mic is open, or the mic won't start), go to ⚙ → Hearing → **iPhone**. That uses the
iPhone's own hearing, which takes turns: it listens to Glen (blue), then Lucy (red),
and you tap a name to switch who it's listening to.

### Tap-to-talk (one line at a time)
With Conversation mode stopped, tap **Glen** or **Lucy** to translate a single line.

### What's on each card
- **What was said**, plus *Phone heard:* when the app fixed a recognition mistake
  (e.g. 傻子 → 啥子, common with Chongqing accents)
- **Translation**, with pinyin for the Chinese side
- **✓ checked**: passed the back-translation check before being spoken
- **✓ checked · corrected**: a problem was found and fixed before speaking
- **⚠ check this**: still uncertain after 3 rounds; spoken, but flagged
- **📝 Notes**: dialect words and slang explained (e.g. 巴适, 好多, "arvo")
- **❓ To confirm**: a genuine ambiguity (e.g. 四 vs 十). Tap **🗣 Ask Lucy** to
  play a short question in Mandarin asking her to confirm.
- **How it was checked**: tap to see the back-translation used for the check

### Learning each other's language
- **🔊 Replay** and **🐢 Slow** under every line, in both languages
- **Pinyin** under every Chinese line
- **📝 Notes** explain slang, dialect and useful phrases, in English *and* Chinese

### ⌨ Type
Type a line for either person when speaking isn't practical.

### ↑ Save (the record)
The whole conversation is kept on the phone automatically, even if the app is closed.
Choose **Copy for: Glen** (English headings and notes) or **Lucy** (中文标题和注释).
Both copies show English and Chinese side by side with pinyin, so you can compare
and study from them. Save or share as a **Page** (prints nicely), **Text**,
**Spreadsheet** (opens in Excel/Numbers with Chinese intact) or **Copy**. On iPhone
this opens the Share sheet: Messages, WeChat, Mail, Files, AirDrop.

### ⚙ Settings
- **Names**: the two people's names (used on screen, in prompts and in the record)
- **About you both**: set to *"We are a couple. We talk to each other in a relaxed,
  affectionate, informal way."* Edit it any time (e.g. add Lucy's district)
- **Hearing**: *OpenAI* (hands-free, recommended) or *iPhone* (taking turns)
- **Check first**: *Before speaking* (most accurate, about 2–4 s slower) or *After*
  (speaks immediately; flags problems afterwards)
- **Mic pickup** / **Wait for pause** (OpenAI hearing) or **Turns** (iPhone hearing)
- **Voice speed**, **Script** (简/繁), **Pinyin**, **Text size**, **Passcode**
- **Clear conversation** (asks first, so export before clearing)

---

## FUTURE UPDATES

When I make improvements to the app:
1. I'll provide updated `App.jsx` file
2. You replace the file in your GitHub repository
3. Netlify auto-deploys within 60 seconds
4. App updates on your phone automatically (PWA auto-update)

---

*Built by Claude (Anthropic) for Glen Williams · June 2026*
