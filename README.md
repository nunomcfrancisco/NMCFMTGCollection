# 🃏 My Magic Collection

**Free** web app to manage your *Magic: The Gathering* collection.

- **Free:** interface on GitHub Pages + database on the free plan of [Firebase](https://firebase.google.com) (Firestore).
- **No card API keys:** card data and images come from [Scryfall](https://scryfall.com).
- **In the cloud:** the collection is stored in **Firestore** (one document per card), not in the browser. You sign in with your **Google** account and get the same collection on any device, with real-time sync. Firestore handles the offline cache.

## Features

- 🗂️ Browse **sets** and mark the cards you have (missing ones are grayed out)
- ➕ Add cards to the collection with a *foil* marker
- 📊 Statistics: total cards, unique cards and estimated value (in EUR)
- 🔃 Filter and sort (name, value, quantity, recent)
- 💾 Export / import the collection as JSON (backup and migration between devices)
- 🖼️ Large card preview

## Database (required)

The collection lives in [Firebase](https://firebase.google.com)'s **Firestore** — free
plan (*Spark*), no credit card. Set it up once:

1. Create a free project in the [Firebase Console](https://console.firebase.google.com).
2. **Firestore Database → Create database** (*Production* mode, pick a location).
3. Go to the **Rules** tab, paste the contents of [`firestore.rules`](firestore.rules) and click **Publish** (ensures each user only accesses their own cards).
4. **Authentication → Get started → Sign-in method →** enable the **Google** provider.
5. **Project settings (⚙️) → General →** under *Your apps*, add a **Web app** (`</>`) and copy the `firebaseConfig` object. Paste it into the [`config.js`](config.js) file:
   ```js
   window.FIREBASE_CONFIG = {
     apiKey: "…",
     authDomain: "your-project.firebaseapp.com",
     projectId: "your-project",
     storageBucket: "your-project.appspot.com",
     messagingSenderId: "…",
     appId: "…",
   };
   ```
6. **Authentication → Settings → Authorized domains →** add your app's domain
   (e.g. `<user>.github.io`) so Google login works there.

When you open the app an **entry gate** appears: you click **Sign in with Google** and the
collection is loaded from the database. Each card is a document in
`users/{uid}/cards/{cardId}`; adding/removing/marking *foil* writes to Firestore right away.
The values in `config.js` are public by design — security comes from the
*Firestore Security Rules* ([`firestore.rules`](firestore.rules)).

### Single-owner app

This app has a **single owner**: only the `nunomcfrancisco@gmail.com` account can sign in.
Any other Google account is rejected, with a message on the entry gate.

This is enforced at two layers:

- **In the app** (UX): [`config.js`](config.js) has `window.ALLOWED_EMAIL` — if you sign in
  with another account, the session is ended immediately. Leave the variable empty (`""`) to
  allow any Google account again.
- **In the database** (real security): the [`firestore.rules`](firestore.rules) only
  allow reading/writing for that account (verified email). The client can be
  bypassed; the *rules* cannot.

> **Important:** when you change the email (or the owner), update it **in both places** —
> `ALLOWED_EMAIL` in `config.js` **and** the email in `firestore.rules` — and **re-publish**
> the rules in the Firebase Console (**Firestore Database → Rules → Publish**),
> otherwise the security restriction has no effect.

> **Offline:** Firestore keeps a local cache; without a connection you can still view and
> edit the collection, and the changes sync as soon as the connection is back.

## How to use locally

Since the interface is just HTML/CSS/JS, you can simply open `index.html` in a browser. To
avoid browser restrictions, run a simple local server:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

You still need `config.js` filled in (see above) for the database to work.

## Publish on GitHub Pages (free)

The repository already includes a workflow (`.github/workflows/deploy.yml`) that publishes
automatically. You only need to enable Pages once:

1. On GitHub, go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Push to the main branch — the app will be at
   `https://<user>.github.io/<repository>/`.

## Collection migration (JSON)

If you had data in another version, use the **Export** button to save the collection as
JSON and, after signing in to the Firebase version, **Import JSON** puts it back
into the database (each card becomes a document in Firestore).

## Notes

- Prices are estimates from Scryfall and change over time.
- The collection is in the database; even so, use **Export** from time to time
  for an extra JSON backup.

---

Data and images © [Scryfall](https://scryfall.com). This project is not affiliated
with Wizards of the Coast.
