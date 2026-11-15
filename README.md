# 📉 Monitor de Preços

Acompanha o preço de produtos todos os dias e manda alerta no WhatsApp quando o preço cai.
Na Black Friday entra em **modo intensivo** e verifica a cada X minutos (de madrugada inclusive).

- Painel web simples para cadastrar produtos, números de WhatsApp e a agenda
- Alerta quando o preço entra na **sua faixa** (ex.: avisar a partir de R$ 2.800, ideal R$ 2.500) ou quando **cai X%** desde a última leitura
- Histórico de preços (minigráfico), menor preço já visto e log das mensagens enviadas
- Janelas da próxima Black Friday e da Cyber Monday já vêm cadastradas

## Rodar

Requer Node.js 22.13 ou mais novo (usa o SQLite embutido no Node).

```bash
npm install
```

```bash
npm start
```

Abra **http://localhost:3000**.

Antes de cadastrar, dá para testar se um link funciona:

```bash
npm run check-url -- "https://www.kabum.com.br/produto/..."
```

## Quais lojas funcionam

Testado em 15/11/2026:

| Loja | Funciona? |
| --- | --- |
| Amazon | ✅ |
| Kabum | ✅ |
| Lojas com dados de produto na página (JSON-LD / meta tags), comum em VTEX, Shopify, WooCommerce, Nuvemshop | ✅ geralmente |
| Mercado Livre, link de afiliado (`mercadolivre.com.br/social/...`) | ✅ lê o card em destaque (preço à vista/Pix) |
| Mercado Livre, página normal do produto | ❌ bloqueia acesso automático |
| Magazine Luiza, Casas Bahia | ❌ bloqueiam acesso automático (HTTP 403) |

- Se a loja não expõe o preço, informe um **seletor CSS** no cadastro (botão direito no preço → Inspecionar → copie a classe, ex.: `.preco-final`).
- Algumas lojas publicam o preço "cheio" e não o do PIX. Para acompanhar quedas isso não importa, mas defina a faixa de preço pensando no mesmo valor que o monitor mostra.
- O painel mostra o erro de cada produto (bloqueio, preço não encontrado etc.).

## WhatsApp

Escolha o provedor no painel em **Agenda e alertas → Envio de WhatsApp**. Comece pelo modo **Teste**: a mensagem aparece só no terminal. Depois use o botão **Enviar teste no WhatsApp**.

| Provedor | Custo | Como configurar |
| --- | --- | --- |
| **CallMeBot** | grátis | Cada pessoa que vai receber manda uma mensagem de autorização para o número do CallMeBot e recebe uma *apikey* ([instruções e número atual](https://www.callmebot.com/blog/free-api-whatsapp-messages/)). Cadastre o número + apikey no painel. Mais simples para uso pessoal. |
| **Evolution API** | grátis (você hospeda) | Conecta **o seu próprio WhatsApp** por QR code e envia para qualquer número. Preencha `EVOLUTION_URL`, `EVOLUTION_APIKEY`, `EVOLUTION_INSTANCE` no `.env`. Não é oficial: use com moderação para não ter o número bloqueado. |
| **WhatsApp Cloud API** | oficial da Meta | Preencha `WA_CLOUD_TOKEN` e `WA_CLOUD_PHONE_ID` no `.env`. A Meta só deixa enviar texto livre até 24h depois que a pessoa mandou mensagem para o seu número comercial. Na Black Friday, mande um "oi" para ele antes da madrugada. |

Copie `.env.example` para `.env` para preencher as credenciais.

### Evolution API (seu número, via QR code)

A pasta `evolution/` já tem tudo para rodar a Evolution API no Docker, acessível só neste computador.

1. Abra o **Docker Desktop**.
2. Gere as chaves (uma vez só). Isso cria `evolution/.env` e preenche as variáveis `EVOLUTION_*` no `.env` do monitor:

   ```bash
   npm run evolution:setup
   ```

   Se o `evolution/.env` sumir (por exemplo, ao copiar o projeto para outra pasta), rode o mesmo comando: com a Evolution já instalada no Docker, ele recupera as chaves dela em vez de criar novas.

3. Suba a Evolution API:

   ```bash
   npm run evolution:up
   ```

4. Rode o monitor (`npm start`). No painel, em **Agenda e alertas**, escolha **Evolution API** e salve.
5. Em **Números de WhatsApp**, clique em **Conectar WhatsApp** e escaneie o QR code no celular: **WhatsApp → Configurações → Aparelhos conectados → Conectar aparelho**.
6. Cadastre quem vai receber os alertas e clique em **Enviar teste no WhatsApp**.

Importante:
- **Os alertas saem do número que você conectar.** Se você mandar para esse mesmo número, a mensagem cai no chat "Você" e normalmente não toca notificação. Para ser acordado na madrugada da Black Friday, conecte um **segundo número** (um chip extra, ou WhatsApp Business num número separado) e cadastre o seu número principal como destinatário.
- A conexão fica salva no Docker. Os containers voltam sozinhos quando o Docker abre. O painel avisa em vermelho se o WhatsApp desconectar.
- Para parar a Evolution: `npm run evolution:down`.

Os alertas de uma mesma verificação vão juntos numa mensagem só:

```
🔥 *Alerta de preço*

*SSD Kingston NV3 1TB*
💰 R$ 1.099,90 (antes R$ 1.149,99, -4%)
🎯 Chegou no seu preço ideal (R$ 1.100,00)
⭐ Menor preço já registrado
https://www.kabum.com.br/produto/621162/...
```

## Agenda

- **Horários diários** (padrão `08:00,20:00`): fora das janelas, verifica nesses horários.
- **Janelas intensivas**: entre o início e o fim, verifica a cada X minutos. Já vêm cadastradas:
  - Black Friday, madrugada: 26/11 22:00 → 27/11 06:00, a cada 5 min
  - Black Friday, dia: 27/11 06:00 → 28/11 00:00, a cada 15 min
  - Cyber Monday: 30/11 00:00 → 01/12 00:00, a cada 30 min
- **Faixa de preço** (por produto, os dois campos são opcionais):
  - **Avisar a partir de**: quando o preço fica igual ou abaixo desse valor, avisa. Avisa de novo a cada nova queda; preço repetido não gera aviso.
  - **Preço ideal**: quando chega nele ou abaixo, o aviso vem destacado com 🎯.
  - Se o preço sair da faixa (subir acima do "avisar a partir de"), o aviso é rearmado.
  - Exemplo com faixa R$ 2.800 → ideal R$ 2.500: R$ 2.950 não avisa; R$ 2.790 avisa 📉; R$ 2.650 avisa 📉; R$ 2.480 avisa 🎯; R$ 2.300 avisa 🎯.
- **Queda**: avisa também quando cai pelo menos X% desde a leitura anterior (padrão 5%; 0 desliga).
- O fuso padrão é `America/Sao_Paulo` (mude com `TZ` no `.env`).

## Deixar rodando na Black Friday

O monitor só verifica enquanto o processo está rodando **e o computador está acordado**. Com a Evolution, o Docker Desktop também precisa estar aberto.

- **No Mac:** deixe na tomada e rode com `caffeinate`, que impede o Mac de dormir:

  ```bash
  caffeinate -i npm start
  ```

- **Num servidor (VPS):** no `.env`, defina `HOST=0.0.0.0` e `DASHBOARD_PASSWORD`. O painel passa a pedir usuário e senha. Use `pm2` ou `systemd` para manter o processo de pé.

## Segurança

- Por padrão o painel só abre no próprio computador (`127.0.0.1`).
- Para abrir na rede, a senha é obrigatória: sem ela o servidor não sobe.
- As apikeys dos contatos nunca são enviadas para o navegador.

## Estrutura

```
src/server.js     servidor HTTP, API e o loop do agendador
src/monitor.js    verifica os preços e decide os alertas
src/scraper.js    lê o preço da página (seletor, Amazon, JSON-LD, meta tags)
src/schedule.js   horários diários, janelas intensivas e datas da Black Friday
src/whatsapp.js   provedores de envio
src/db.js         banco SQLite (data/monitor.db)
public/index.html o painel
evolution/        Docker Compose e gerador de chaves da Evolution API
test/             testes (npm test)
```
