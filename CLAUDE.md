# CLAUDE.md

Guia para sessões do Claude Code neste projeto. Uso, lojas, provedores de WhatsApp e agenda do ponto de vista do usuário estão no [README.md](README.md); aqui fica só o que não é óbvio lendo o código.

## O que é

Monitor de preços com painel web, alerta no WhatsApp e modo intensivo na Black Friday. Node 22.13+ com ESM, sem framework: `node:http`, `node:sqlite` (`DatabaseSync`) e `fetch` nativo. Única dependência: `cheerio` (não adicione outras sem necessidade).

- `npm start` (ou `npm run dev`, com `--watch`): painel em http://127.0.0.1:3000
- `npm test`: `node:test` em `test/*.test.js` (só funções puras; não sobe servidor nem abre o banco)
- `npm run check-url -- "<url>" ["seletor"]`: testa a extração de um link
- `npm run evolution:setup|up|down`: chaves e Docker da Evolution API
- `npm run service:install|uninstall|restart`: o monitor como LaunchAgent do macOS (`service/install.mjs`, label `com.monitor-precos`, plist em `~/Library/LaunchAgents`, `KeepAlive`, `caffeinate -i` + caminho absoluto do Node da instalação, log em `data/monitor.log`). O install recusa se a porta já estiver ocupada.

## Mapa de src/

- `server.js`: carrega o `.env`, define `TZ` e só depois importa os módulos (`await import`, mantenha essa ordem); rotas da API, validação, autenticação e o loop do agendador.
- `db.js`: `openDb` cria o schema, roda migrações, grava settings padrão e as janelas da Black Friday na primeira execução.
- `monitor.js`: `runCheck` (lê preços, grava histórico, decide e envia alertas), `evaluatePrice`, `alertBlock`, `buildMessages`, `notifyAll`.
- `scraper.js`: `fetchPage`, `extractFromHtml`, `parsePrice` (formatos BR e internacionais) e `looksBlocked`.
- `search.js`: produtos por busca (`kind = 'search'`): fontes (`SOURCES`), filtro por palavras (`matchOffers`), cache por fonte e `searchProduct`.
- `schedule.js`: horários diários, janelas intensivas, `computeNextRun` e a data da Black Friday.
- `whatsapp.js`: provedores, `normalizePhone` (sem DDI assume 55), status e QR da Evolution.
- `check-url.js`: CLI do `npm run check-url`.
- `public/index.html`: o painel inteiro (HTML, CSS e JS sem build); recarrega `GET /api/state` a cada 10 s.

## Convenções

- Interface, mensagens de erro, README e comentários em português; nomes no código (variáveis, funções, colunas, rotas) em inglês.
- Mudança de schema é migração em `openDb` (`src/db.js`): ler `PRAGMA table_info(<tabela>)` e só fazer `ALTER TABLE ... ADD COLUMN` se a coluna faltar (exemplo: `alert_from_price`). Nunca recriar tabelas: `data/monitor.db` tem o histórico real do usuário.
- Configurações ficam na tabela `settings` (chave/valor em texto); padrões em `DEFAULT_SETTINGS`, inseridos com `INSERT OR IGNORE`.

## Regras de alerta (`evaluatePrice`, src/monitor.js)

- Faixa: `alert_from_price` ("avisar quando custar até", o limite de cima) e `target_price` ("preço ideal"). Sem limite, a faixa começa no ideal. Na interface, nunca use "a partir de" para esse limite: passa a ideia de "daí para cima".
- Avisa quando o preço entra na faixa (`<=`) e de novo a cada queda abaixo de `last_alert_price`; preço repetido não avisa. Motivo `target` (🎯) se estiver `<=` ideal, senão `range` (📉).
- Preço acima da faixa zera `last_alert_price` (rearma). Mudar a faixa pelo painel (`PUT /api/products/:id`) também rearma.
- Independente da faixa: `drop` quando cai pelo menos `drop_alert_pct`% em relação a `last_price` (0 desliga; a primeira leitura nunca avisa).
- Os alertas de uma rodada vão juntos numa mensagem (`buildMessages` só quebra acima de 3000 caracteres). Todo envio fica registrado na tabela `alerts`.
- `test/monitor.test.js` descreve a sequência esperada; atualize junto com a regra.

## Extração do preço (`extractFromHtml`, src/scraper.js)

Ordem, parando no primeiro que achar:

1. Seletor CSS do produto. Se falhar, lança erro (não cai para os próximos).
2. Link de afiliado do Mercado Livre (`/social/`): lê o `.poly-card` cujo título é igual ao `og:title` (sem o " - R$..."). Sem card igual, não lê o preço de outro produto.
3. `SITE_SELECTORS` por loja (Amazon; há também `meta[itemprop="price"]` para o Mercado Livre).
4. JSON-LD (`Product`/`ProductGroup`, inclusive `@graph` e `AggregateOffer.lowPrice`).
5. Meta tags (`product:price:amount`, `og:price:amount`, `itemprop="price"`).

Funcionam Amazon, Kabum e links de afiliado do ML. Magalu, Casas Bahia e a página normal de produto do ML bloqueiam (HTTP 403 ou captcha), e a mensagem de erro já diz isso. Não adicione técnicas para burlar anti-bot (stealth, navegador disfarçado, resolver captcha, rotação de IP).

## Produtos por busca (src/search.js)

- `products.kind`: `'link'` (padrão, usa `url`/`selector`) ou `'search'` (usa `query`, `required_words`, `excluded_words`, `min_price`, `sources`; `url` fica vazia). Na busca, `last_price` é a oferta mais barata que bateu; `best_store`, `best_url` e `offers_json` (`{offers, failures}`) guardam o resto. O tipo não muda depois de criado.
- Fontes: Buscapé e Zoom (mesmo catálogo, lido de `__NEXT_DATA__.props.initialReduxState.hits.hits`, com `bestOffer.merchantName`), Amazon (cards `s-search-result`, link por ASIN) e Kabum (`__NEXT_DATA__ ... catalogServer.data`, menor entre `price` e `priceWithDiscount`). Padrão: `buscape,amazon,kabum`.
- `matchOffers`: todas as palavras obrigatórias (vírgula ou espaço; sem nenhuma, as da busca) e nenhuma excluída (só vírgula; aceita expressões), sem acento e sem maiúscula; números só casam "soltos" (`55` não casa com `550`). Depois, `min_price`, URL repetida e ordem por preço.
- Cache em memória por fonte e busca (`minIntervalMin`: comparadores 10, Amazon 10, Kabum 0), para não martelar os sites no modo intensivo. Uma fonte com falha não derruba as outras; só dá erro se nenhuma oferta bater.
- Mudar a busca (`PUT`) zera `last_price` e `last_alert_price`, para não gerar alerta de queda falso. `POST /api/search-preview` mostra o resultado sem salvar (botão "Testar busca").
- `products.payment`: `'avista'` (padrão, menor preço/Pix) ou `'parcelado'`. No parcelado, só valem ofertas com `installments` (`{count, value, total}`, só quando a loja marca "sem juros"; `parseInstallments` em scraper.js) e o preço passa a ser `installments.total` (`applyPayment` em search.js; em links, no `runCheck`). Kabum: sem juros quando parcelas × valor ≈ `price`; Buscapé/Zoom: quando `total_value <= price`. Mudar a forma de pagamento zera `last_price`, como mudar a busca.
- Pelando/Promobit ficaram de fora (promoções antigas geram alerta falso). Mercado Livre bloqueia a busca e a API pede token de app de desenvolvedor.

## Agendador (src/schedule.js + loop em src/server.js)

- Um `setInterval` de 15 s compara a hora com `state.nextRunAt`. `computeNextRun` pega o menor entre o próximo horário diário, o início da próxima janela, dentro de uma janela `last_run_at + interval_min` da janela (ou agora, se ainda não rodou nela) e, se `settings.interval_min > 0` (`everyMin`, mínimo 5), `last_run_at + everyMin`.
- `last_run_at` é salvo em `settings` no início de cada rodada (agendada ou "Verificar agora"), então sobrevive a reinícios. Verificar ou cadastrar um produto só não mexe nele.
- As janelas da próxima Black Friday (sexta após a 4ª quinta de novembro) e da Cyber Monday são inseridas uma única vez (flag `windows_seeded`); nos anos seguintes não se renovam sozinhas.
- Fuso: `process.env.TZ ||= 'America/Sao_Paulo'` em server.js. Datas no banco em ISO (UTC); horários diários no fuso do processo. Os testes de agenda fixam `TZ` antes de importar.

## Segurança do painel

- Sem `DASHBOARD_PASSWORD`, o servidor só sobe com `HOST` de loopback e recusa requisições cujo cabeçalho `Host` não seja localhost/127.0.0.1/::1 (contra DNS rebinding). Com senha, usa Basic Auth com `timingSafeEqual`.
- Escritas em `/api/` exigem `Content-Type: application/json` (força o preflight, contra CSRF). Mantenha isso em rotas novas.
- As apikeys dos contatos nunca vão para o navegador: `/api/state` só manda `has_apikey`, e apikey vazia no `PUT` mantém a atual.
- No painel, todo texto vindo do banco ou das lojas passa por `esc()` antes de ir para `innerHTML`. O QR da Evolution é validado no servidor como `data:image/...;base64`.

## WhatsApp e Evolution API

- O provedor é escolhido no painel (`settings.whatsapp_provider`): `console` | `callmebot` | `evolution` | `cloudapi`. Credenciais só no `.env` (`PROVIDERS[...].env` lista as obrigatórias); a apikey do CallMeBot fica em cada contato, no banco.
- A Evolution roda no Docker (`evolution/`, projeto `evolution`: containers `evolution-api-1` e `evolution-postgres-1`, volume `evolution_postgres_data`), publicada só em `127.0.0.1:8080`, instância `monitor-precos`, conectada por QR no painel (`POST /api/whatsapp/connect` cria a instância se faltar).
- `.env` e `evolution/.env` estão no `.gitignore` e não vão junto quando o projeto é movido ou copiado. Nunca leia nem mostre o conteúdo deles.
- Se faltarem, recrie com `npm run evolution:setup` (precisa do Docker aberto). Sem `evolution/.env`, ele olha o Docker: se o volume `evolution_postgres_data` já existe, recupera as chaves do container `evolution-api-1` (sem imprimir) em vez de gerar novas, que não abririam o banco antigo; se o volume existe mas o container não, para com instruções. Chaves novas só numa instalação do zero. Não gere chaves por outro caminho.

## Verificar mudanças sem afetar o usuário

- O monitor do usuário roda como serviço do launchd (`com.monitor-precos`) na porta 3000 com `data/monitor.db`; a saída está em `data/monitor.log`. Não suba nada na 3000 nem outra instância usando `data/monitor.db` (seriam dois agendadores e alertas duplicados). Matar o processo não adianta: o launchd sobe de novo em até 30 s.
- Comece por `npm test`.
- Para testar o painel, use uma cópia do banco com o provedor em `console` antes de subir:

  ```bash
  sqlite3 data/monitor.db ".backup '/caminho/copia.db'"   # inclui o que ainda está no WAL
  sqlite3 /caminho/copia.db "UPDATE settings SET value='console' WHERE key='whatsapp_provider'"
  DB_FILE=/caminho/copia.db PORT=3124 npm start
  ```

  Variáveis da linha de comando têm prioridade sobre o `.env`, mas ele continua sendo carregado (com as credenciais): com outro provedor, cadastrar ou verificar produtos, ou o próprio agendador da cópia, mandaria WhatsApp de verdade.
- Nunca envie mensagem de teste real ("Enviar teste no WhatsApp", `POST /api/test-message` ou a Evolution direto) sem o usuário confirmar.
- O monitor do usuário não recarrega sozinho: depois de mudar o código, reinicie com `npm run service:restart` (ou avise o usuário para rodar).
