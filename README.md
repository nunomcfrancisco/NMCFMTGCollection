# 🃏 A Minha Coleção Magic

Web app **100% grátis** para gerir a tua coleção de *Magic: The Gathering*.

- **Sem custos:** hospedada no GitHub Pages, sem servidor nem base de dados.
- **Sem chaves de API:** os dados e imagens das cartas vêm da [Scryfall](https://scryfall.com).
- **Privada:** a coleção fica guardada apenas no teu browser (`localStorage`). Faz **Exportar** para backup.

## Funcionalidades

- 🔍 Procurar cartas com a sintaxe da Scryfall (`t:dragon`, `c:red cmc<=3`, `set:mh3`, …)
- ➕ Adicionar cartas à coleção com quantidade e marca de *foil*
- 📊 Estatísticas: total de cartas, cartas únicas e valor estimado (em EUR)
- 🔃 Filtrar e ordenar (nome, valor, quantidade, recentes)
- 💾 Exportar / importar a coleção em JSON (backup e migração entre dispositivos)
- 🖼️ Pré-visualização da carta em grande

## Como usar localmente

Como é só HTML/CSS/JS, basta abrir o `index.html` num browser. Para evitar
restrições do browser, corre um servidor local simples:

```bash
python3 -m http.server 8000
# abre http://localhost:8000
```

## Publicar no GitHub Pages (grátis)

O repositório já inclui um workflow (`.github/workflows/deploy.yml`) que publica
automaticamente. Só precisas de ativar o Pages uma vez:

1. No GitHub, vai a **Settings → Pages**.
2. Em **Build and deployment → Source**, escolhe **GitHub Actions**.
3. Faz push para o branch principal — a app fica em
   `https://<utilizador>.github.io/<repositorio>/`.

## Sincronização na nuvem (opcional, grátis)

Por defeito a coleção vive só no browser. Para a sincronizares entre
dispositivos (PC, telemóvel…), ativa o [Supabase](https://supabase.com) —
plano gratuito, sem cartão de crédito:

1. Cria uma conta em <https://supabase.com> e um **New project** (grátis).
2. Vai a **SQL Editor**, cola o conteúdo de [`supabase-setup.sql`](supabase-setup.sql) e clica em **Run** (cria a tabela e as regras de segurança).
3. Vai a **Settings → API** e copia o **Project URL** e a **anon public key**.
4. Cola-os no ficheiro [`config.js`](config.js):
   ```js
   window.SUPABASE_CONFIG = {
     url: "https://xxxx.supabase.co",
     anonKey: "eyJhbGci...",
   };
   ```
5. (Opcional) Em **Authentication → URL Configuration**, adiciona o URL da tua
   app (ex.: `https://<utilizador>.github.io/<repo>/`) aos *Redirect URLs*.

Feito isto, aparece um botão **☁️ Entrar / Sincronizar** no topo. Entras com o
email (recebes um link mágico, sem password) e a coleção passa a sincronizar
automaticamente. A `anon key` é pública por design — a segurança é garantida
pelas *Row Level Security policies* do `supabase-setup.sql`, que impedem cada
utilizador de ver dados dos outros.

> Sem configurares nada, a app continua a funcionar em **modo local** (badge 💾 Local).

## Notas

- Os preços são estimativas da Scryfall e mudam ao longo do tempo.
- Como a coleção vive no `localStorage`, limpar os dados do browser apaga-a —
  usa **Exportar** regularmente.

---

Dados e imagens © [Scryfall](https://scryfall.com). Este projeto não é afiliado
à Wizards of the Coast.
