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

## Notas

- Os preços são estimativas da Scryfall e mudam ao longo do tempo.
- Como a coleção vive no `localStorage`, limpar os dados do browser apaga-a —
  usa **Exportar** regularmente.

---

Dados e imagens © [Scryfall](https://scryfall.com). Este projeto não é afiliado
à Wizards of the Coast.
