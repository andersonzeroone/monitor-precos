// Testa rapidamente se o monitor consegue ler o preço de um link:
//   npm run check-url -- "https://loja.com/produto" ["seletor css opcional"]
import { checkPrice } from './scraper.js';

const [url, selector] = process.argv.slice(2);
if (!url) {
  console.log('Uso: npm run check-url -- "<link do produto>" ["seletor css opcional"]');
  process.exit(1);
}
try {
  const { price, title, source } = await checkPrice(url, selector);
  console.log(`Produto: ${title}\nPreço:   R$ ${price.toFixed(2).replace('.', ',')}\nFonte:   ${source}`);
} catch (err) {
  console.error(`Erro: ${err.name === 'TimeoutError' ? 'a loja demorou demais para responder' : err.message}`);
  process.exit(1);
}
