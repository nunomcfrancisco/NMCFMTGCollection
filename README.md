# 🃏 A Minha Coleção Magic

Web app **grátis** para gerir a tua coleção de *Magic: The Gathering*.

- **Grátis:** interface no GitHub Pages + base de dados no plano gratuito do [Firebase](https://firebase.google.com) (Firestore).
- **Sem chaves de API de cartas:** os dados e imagens das cartas vêm da [Scryfall](https://scryfall.com).
- **Na nuvem:** a coleção é guardada no **Firestore** (uma *document* por carta), não no browser. Entras com a tua conta **Google** e tens a mesma coleção em qualquer dispositivo, com sincronização em tempo real. O Firestore trata da cache offline.

## Funcionalidades

- 🔍 Procurar cartas com a sintaxe da Scryfall (`t:dragon`, `c:red cmc<=3`, `set:mh3`, …)
- ➕ Adicionar cartas à coleção com quantidade e marca de *foil*
- 📊 Estatísticas: total de cartas, cartas únicas e valor estimado (em EUR)
- 🔃 Filtrar e ordenar (nome, valor, quantidade, recentes)
- 💾 Exportar / importar a coleção em JSON (backup e migração entre dispositivos)
- 🖼️ Pré-visualização da carta em grande

## Base de dados (obrigatória)

A coleção vive no **Firestore** do [Firebase](https://firebase.google.com) — plano
gratuito (*Spark*), sem cartão de crédito. Configura uma vez:

1. Cria um projeto grátis na [Firebase Console](https://console.firebase.google.com).
2. **Firestore Database → Create database** (modo *Production*, escolhe uma localização).
3. Vai ao separador **Rules**, cola o conteúdo de [`firestore.rules`](firestore.rules) e clica em **Publish** (garante que cada utilizador só acede às suas cartas).
4. **Authentication → Get started → Sign-in method →** ativa o provider **Google**.
5. **Project settings (⚙️) → General →** em *Your apps*, adiciona uma **Web app** (`</>`) e copia o objeto `firebaseConfig`. Cola-o no ficheiro [`config.js`](config.js):
   ```js
   window.FIREBASE_CONFIG = {
     apiKey: "…",
     authDomain: "o-teu-projeto.firebaseapp.com",
     projectId: "o-teu-projeto",
     storageBucket: "o-teu-projeto.appspot.com",
     messagingSenderId: "…",
     appId: "…",
   };
   ```
6. **Authentication → Settings → Authorized domains →** adiciona o domínio da tua app
   (ex.: `<utilizador>.github.io`) para o login com Google funcionar aí.

Ao abrir a app aparece uma **porta de entrada**: clicas em **Entrar com Google** e a
coleção é carregada da base de dados. Cada carta é uma *document* em
`users/{uid}/cards/{cardId}`; adicionar/remover/marcar *foil* grava logo no Firestore.
Os valores do `config.js` são públicos por design — a segurança vem das
*Firestore Security Rules* ([`firestore.rules`](firestore.rules)), que impedem cada
utilizador de aceder aos dados dos outros.

> **Offline:** o Firestore mantém uma cache local; sem ligação continuas a ver e a
> editar a coleção, e as alterações sincronizam assim que a ligação voltar.

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

## Migração da coleção (JSON)

Se tinhas dados noutra versão, usa o botão **Exportar** para gravar a coleção em
JSON e, depois de entrares na versão Firebase, o **Importar JSON** volta a colocá-la
na base de dados (cada carta passa a ser uma *document* no Firestore).

## Notas

- Os preços são estimativas da Scryfall e mudam ao longo do tempo.
- A coleção está na base de dados; ainda assim, usa **Exportar** de vez em quando
  para um backup extra em JSON.

---

Dados e imagens © [Scryfall](https://scryfall.com). Este projeto não é afiliado
à Wizards of the Coast.
