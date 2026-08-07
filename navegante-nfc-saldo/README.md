# navegante NFC — leitor de saldo

App Android **gratuita e open-source** que lê um cartão **navegante** (antigo
*Lisboa Viva*) por **NFC** e tenta mostrar o **saldo do zapping**.

O cartão navegante é um cartão **Calypso** (ISO 14443-4). A app seleciona a
aplicação de transporte e lê os ficheiros acessíveis do cartão, apresentando:

- uma **estimativa do saldo** (a partir dos ficheiros de contador);
- o **dump completo em hexadecimal** de tudo o que foi lido, para verificação.

> ⚠️ **Estado honesto do projeto.** O layout exato dos bytes onde o navegante
> guarda o saldo **não é documentação pública** (sistema proprietário
> Thales/Card4B). A leitura do cartão funciona; a *interpretação* do saldo é
> uma estimativa que pode precisar de afinação com um cartão real. Por isso a
> app inclui o botão **"Partilhar leitura (hex)"** — envia esse dump para se
> afinar a leitura do valor certo.

## Como obter o APK (sem instalar nada)

1. Vai ao separador **Actions** deste repositório no GitHub.
2. Abre a execução mais recente do workflow **Build APK**.
3. Na secção **Artifacts**, descarrega **`navegante-nfc-debug-apk`**.
4. Descompacta o `.zip` e copia o `app-debug.apk` para o telemóvel.

## Instalar no telemóvel Android

1. Nas Definições, permite **instalar apps de fontes desconhecidas** para o
   gestor de ficheiros / browser que vais usar.
2. Abre o `app-debug.apk` e instala.
3. Garante que o **NFC está ligado** (Definições → Ligações → NFC).

## Usar

1. Abre a app **navegante NFC**.
2. Encosta o **cartão navegante** à traseira do telemóvel (onde está a antena
   NFC — normalmente na metade superior).
3. Mantém o cartão parado 1–2 segundos. A app mostra a estimativa de saldo e o
   dump completo.

## Compilar localmente (opcional)

Precisas do Android Studio ou do SDK de linha de comandos:

```bash
gradle wrapper --gradle-version 8.10.2   # só na primeira vez
./gradlew assembleDebug
# APK em app/build/outputs/apk/debug/app-debug.apk
```

## Como funciona (técnico)

- `MainActivity.kt` — usa `NfcAdapter.enableReaderMode` (NFC-A + NFC-B) e
  entrega o `IsoDep` ao leitor.
- `CalypsoReader.kt` — `SELECT` da aplicação Calypso `1TIC.ICA` e depois um
  `READ RECORD` em força bruta por todos os SFIs (a leitura de registos destes
  ficheiros não exige sessão segura). Procura candidatos a saldo nos ficheiros
  de contador (valores big-endian de 3 bytes, em cêntimos).
- `Hex.kt` — utilitários de hexadecimal.

## Licença

MIT — ver `LICENSE`.

## Aviso

Projeto independente, sem qualquer relação com a Metropolitano de Lisboa,
Carris, TML ou Card4B. Apenas **lê** dados do cartão; nunca os altera.
