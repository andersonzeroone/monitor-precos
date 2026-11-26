# 📉 Monitor de Preços

Acompanha o preço de produtos todos os dias e manda alerta no WhatsApp quando o preço cai.
Na Black Friday entra em **modo intensivo** e verifica a cada X minutos (de madrugada inclusive).

- **Busca pelo nome em várias lojas**: cadastre "tcl 55c6k" e ele acha a oferta mais barata no Buscapé (que reúne várias lojas), Amazon e Kabum, sem precisar de um link
- Ou vigie um **link específico** de uma loja
- Painel web simples para cadastrar produtos, números de WhatsApp e a agenda
- Alerta quando o preço entra na **sua faixa** (ex.: avisar quando custar até R$ 2.800, ideal R$ 2.500) ou quando **cai X%** desde a última leitura
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

## Busca pelo nome (recomendado)

Clique em **＋ Adicionar produto**, no topo do painel, escolha **🔎 Pelo nome** e informe o que buscar. A cada rodada o monitor procura o termo em cada fonte e fica com a oferta mais barata cujo título tem **todas** as palavras obrigatórias. O alerta diz a loja e traz o link; o painel mostra as 5 ofertas mais baratas.

- **O que buscar:** de preferência o código do modelo, ex.: `tcl 55c6k`, `iphone 16 128gb`, `rtx 5070`.
- **Palavras obrigatórias:** sem preencher, valem as palavras da busca. Números precisam estar "soltos": `55` casa com `55"` e `55C6K`, mas não com `550`.
- **Palavras excluídas:** já vem com `suporte, controle, capa, cabo, película, combo, usado, recondicionado`, para não pegar acessório.
- **Ignorar ofertas abaixo de:** descarta preço absurdo (acessório ou erro).
- Use **Testar busca** antes de salvar para ver quais ofertas batem.

| Fonte | O que traz | Consulta no máximo |
| --- | --- | --- |
| Buscapé | Menor preço entre várias lojas (Fast Shop, Magalu, Americanas, Kabum...) | a cada 10 min |
| Zoom | O mesmo catálogo do Buscapé (use um ou outro) | a cada 10 min |
| Amazon | Busca da Amazon | a cada 10 min |
| Kabum | Busca da Kabum, com o preço à vista e o vendedor | sem limite |

Na madrugada da Black Friday, mesmo com a verificação a cada 5 min, Buscapé e Amazon usam o último resultado até passar o intervalo da tabela, para não serem bloqueados. O Mercado Livre bloqueia a busca automática e não aparece no Buscapé para todos os produtos; para ele, use um link de afiliado no modo "link específico".

## Quais lojas funcionam no modo link

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
5. Em **Números de WhatsApp → Quem envia os alertas**, clique em **Conectar WhatsApp** e escaneie o QR code no celular do número que vai enviar: **WhatsApp (ou WhatsApp Business) → Configurações → Aparelhos conectados → Conectar aparelho**. O painel passa a mostrar "enviando de +55...".
6. Em **Quem recebe os alertas**, cadastre os números que vão receber e clique em **Enviar teste no WhatsApp**.

Importante:
- **Os alertas saem do número que você conectar.** Se você mandar para esse mesmo número, a mensagem cai no chat "Você" e não toca notificação; o painel marca esse contato em vermelho. Para ser acordado na madrugada da Black Friday, conecte um **segundo número** (um chip extra com WhatsApp Business) e cadastre o seu número principal como destinatário.
- Para trocar o número que envia, clique em **Trocar número**: ele desconecta o atual e mostra um QR code novo.
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

- **Verificar a cada (min)** (padrão 0, desligado): verifica tudo a cada X minutos, o dia todo. Mínimo de 5.
- **Horários diários** (padrão `08:00,20:00`): verifica também nesses horários.
- **Janelas intensivas**: entre o início e o fim, verifica a cada X minutos. Já vêm cadastradas:
  - Black Friday, madrugada: 26/11 22:00 → 27/11 06:00, a cada 5 min
  - Black Friday, dia: 27/11 06:00 → 28/11 00:00, a cada 15 min
  - Cyber Monday: 30/11 00:00 → 01/12 00:00, a cada 30 min
- **Faixa de preço** (por produto, os dois campos são opcionais):
  - **Avisar quando custar até**: quando o preço fica igual ou abaixo desse valor, avisa. Avisa de novo a cada nova queda; preço repetido não gera aviso.
  - **Preço ideal**: quando chega nele ou abaixo, o aviso vem destacado com 🎯.
  - Se o preço sair da faixa (subir acima do "avisar quando custar até"), o aviso é rearmado.
  - Se o WhatsApp estiver fora do ar e ninguém receber, o aviso vai de novo na verificação seguinte.
  - Exemplo com faixa R$ 2.800 → ideal R$ 2.500: R$ 2.950 não avisa; R$ 2.790 avisa 📉; R$ 2.650 avisa 📉; R$ 2.480 avisa 🎯; R$ 2.300 avisa 🎯.
- **Queda**: avisa também quando cai pelo menos X% desde a leitura anterior (padrão 5%; 0 desliga).
- **Forma de pagamento** (por produto):
  - **À vista / Pix**: usa o menor preço que a loja mostra.
  - **Parcelado sem juros**: só vale oferta que a loja marca como "sem juros", e o preço comparado com a sua faixa é o **total das parcelas** (ex.: 10x de R$ 359,90 = R$ 3.599). O aviso mostra as parcelas.
  - Onde o parcelamento é lido: Amazon (busca e página do produto), Kabum (busca), Buscapé/Zoom (quando o total parcelado é igual ao preço à vista, que é quando eles escrevem "sem juros") e links de afiliado do Mercado Livre. Em links de outras lojas, o modo parcelado dá erro se a página não mostrar o parcelamento.
- O fuso padrão é `America/Sao_Paulo` (mude com `TZ` no `.env`).

## Deixar rodando na Black Friday

O monitor só verifica enquanto o processo está rodando **e o computador está acordado**. Com a Evolution, o Docker Desktop também precisa estar aberto.

- **No Mac (recomendado): como serviço.** O monitor sobe sozinho quando você entra no Mac, volta em até 30 s se cair e não depende de uma janela de terminal aberta. Ele roda com `caffeinate`, que impede o Mac de dormir por inatividade (com a tampa fechada ele dorme mesmo assim; deixe aberto e na tomada).

  ```bash
  npm run service:install
  ```

  - Antes, pare o `npm start` que estiver rodando num terminal (o script recusa se a porta estiver ocupada).
  - A saída vai para `data/monitor.log` (para acompanhar: `tail -f data/monitor.log`).
  - Depois de atualizar o código: `npm run service:restart`.
  - Se trocar a versão do Node, rode `npm run service:install` de novo.
  - Para desligar e voltar a rodar na mão: `npm run service:uninstall`.
  - Para os alertas saírem pela Evolution depois de reiniciar o Mac, o Docker Desktop precisa abrir sozinho: **Docker Desktop → Settings → General → Start Docker Desktop when you sign in**.

- **No Mac, na mão:** deixe na tomada e rode com `caffeinate`. Para quando o terminal fecha:

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
service/          instala o monitor como serviço do macOS (launchd)
test/             testes (npm test)
```
