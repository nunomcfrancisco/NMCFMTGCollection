# 🃏 A Minha Coleção Magic

Web app **grátis** para gerir a tua coleção de *Magic: The Gathering*.

- **Grátis:** interface no GitHub Pages + base de dados no plano gratuito do [Supabase](https://supabase.com).
- **Sem chaves de API:** os dados e imagens das cartas vêm da [Scryfall](https://scryfall.com).
- **Na nuvem:** a coleção é guardada numa **base de dados** (uma linha por carta), não no browser. Entras com o teu email e tens a mesma coleção em qualquer dispositivo. O browser guarda apenas uma cache para funcionar offline.

## Funcionalidades

- 🔍 Procurar cartas com a sintaxe da Scryfall (`t:dragon`, `c:red cmc<=3`, `set:mh3`, …)
- ➕ Adicionar cartas à coleção com quantidade e marca de *foil*
- 📊 Estatísticas: total de cartas, cartas únicas e valor estimado (em EUR)
- 🔃 Filtrar e ordenar (nome, valor, quantidade, recentes)
- 💾 Exportar / importar a coleção em JSON (backup e migração entre dispositivos)
- 🖼️ Pré-visualização da carta em grande

## Base de dados (obrigatória)

A coleção vive numa base de dados no [Supabase](https://supabase.com) — plano
gratuito, sem cartão de crédito. Configura uma vez:

1. Cria uma conta em <https://supabase.com> e um **New project** (grátis).
2. Vai a **SQL Editor**, cola o conteúdo de [`supabase-setup.sql`](supabase-setup.sql) e clica em **Run** (cria a tabela `collection_cards` e as regras de segurança).
3. Vai a **Settings → API** e copia o **Project URL** e a **anon public key**.
4. Cola-os no ficheiro [`config.js`](config.js):
   ```js
   window.SUPABASE_CONFIG = {
     url: "https://xxxx.supabase.co",
     anonKey: "eyJhbGci...",
   };
   ```
5. (Recomendado) Em **Authentication → URL Configuration**, adiciona o URL da tua
   app (ex.: `https://<utilizador>.github.io/<repo>/`) aos *Redirect URLs*.

Ao abrir a app aparece uma **porta de entrada**: introduzes o email, recebes um
link mágico (sem password) e a coleção é carregada da base de dados. Cada carta
é uma linha na tabela; adicionar/remover/marcar *foil* grava logo na base de dados.
A `anon key` é pública por design — a segurança vem das *Row Level Security
policies* do `supabase-setup.sql`, que impedem cada utilizador de ver dados dos outros.

> **Offline:** se ficares sem ligação, a app usa a cache local e sincroniza as
> alterações assim que a ligação voltar.

## Como usar localmente

Como a interface é só HTML/CSS/JS, basta abrir o `index.html` num browser. Para
evitar restrições do browser, corre um servidor local simples:

```bash
python3 -m http.server 8000
# abre http://localhost:8000
```

Precisas na mesma de ter o `config.js` preenchido (ver acima) para a base de dados funcionar.

## Publicar no GitHub Pages (grátis)

O repositório já inclui um workflow (`.github/workflows/deploy.yml`) que publica
automaticamente. Só precisas de ativar o Pages uma vez:

1. No GitHub, vai a **Settings → Pages**.
2. Em **Build and deployment → Source**, escolhe **GitHub Actions**.
3. Faz push para o branch principal — a app fica em
   `https://<utilizador>.github.io/<repositorio>/`.

## Já usavas a versão antiga (coleção no browser)?

A versão anterior guardava tudo no `localStorage` e tinha uma tabela
`collections` com a coleção num único JSON. Agora cada carta é uma linha na
tabela `collection_cards`. O `supabase-setup.sql` inclui, no fim, um bloco de
migração comentado que converte a tabela antiga para o novo formato — descomenta-o
e corre-o no **SQL Editor** se precisares.

## Notas

- Os preços são estimativas da Scryfall e mudam ao longo do tempo.
- A coleção está na base de dados; ainda assim, usa **Exportar** de vez em quando
  para um backup extra em JSON.

---

Dados e imagens © [Scryfall](https://scryfall.com). Este projeto não é afiliado
à Wizards of the Coast.
