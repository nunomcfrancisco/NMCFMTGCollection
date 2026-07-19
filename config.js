/* ============================================================
   Configuração da base de dados (obrigatória, grátis)
   ------------------------------------------------------------
   A coleção é guardada numa base de dados na nuvem (Supabase),
   não no browser. Cria um projeto grátis em https://supabase.com,
   corre o supabase-setup.sql e cola aqui o URL e a "anon public
   key" (Settings → API).

   Sem isto preenchido, a app pede para configurares a base de dados.
   Ver README.md → secção "Base de dados (obrigatória)".
   ============================================================ */
window.SUPABASE_CONFIG = {
  url: "https://YOUR_PROJECT.supabase.co",
  anonKey: "YOUR_ANON_PUBLIC_KEY",
};
