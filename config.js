/* ============================================================
   Configuração do Firebase (obrigatória, grátis)
   ------------------------------------------------------------
   A coleção é guardada na base de dados Firestore (Firebase),
   não no browser. Cria um projeto grátis em
   https://console.firebase.google.com, adiciona uma "Web app"
   e cola aqui o objeto de configuração (firebaseConfig).

   Sem isto preenchido, a app pede para configurares a base de dados.
   Ver README.md → secção "Base de dados (obrigatória)".

   Nota: estes valores são públicos por design (vão no site). A
   segurança dos dados vem das Firestore Security Rules
   (ficheiro firestore.rules).
   ============================================================ */
window.FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};
