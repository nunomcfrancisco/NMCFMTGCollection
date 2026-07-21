/* ============================================================
   Firebase configuration (required, free)
   ------------------------------------------------------------
   The collection is stored in the Firestore database (Firebase),
   not in the browser. Create a free project at
   https://console.firebase.google.com, add a "Web app"
   and paste the configuration object here (firebaseConfig).

   Without this filled in, the app asks you to configure the database.
   See README.md → "Database (required)" section.

   Note: these values are public by design (they ship in the site). Data
   security comes from the Firestore Security Rules
   (firestore.rules file).
   ============================================================ */
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyB3ZoFZ87fjlq76N71tSvAX1a05OFAUnU0",
  authDomain: "nmcfmtgcollection.firebaseapp.com",
  projectId: "nmcfmtgcollection",
  storageBucket: "nmcfmtgcollection.firebasestorage.app",
  messagingSenderId: "259570155039",
  appId: "1:259570155039:web:b49a66b4009fa14aa61f2a",
  measurementId: "G-5PTKH11H8M",
};

/* ------------------------------------------------------------
   Single-owner app: only this Google account may sign in.
   Any other account is rejected (in the app and in the Firestore Rules,
   see firestore.rules). Leave empty ("") to allow any
   Google account.
   ------------------------------------------------------------ */
window.ALLOWED_EMAIL = "nunomcfrancisco@gmail.com";
