// Поддельный llama-server для тестов: понимает --port, отвечает /health (сначала 503 — «загрузка») и
// /v1/chat/completions потоком. Записывает полученные аргументы в stdout.
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const started = Date.now();
console.log(`args ${JSON.stringify(args)}`);
if (args.includes('--crash')) process.exit(3);
createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(Date.now() - started < 300 ? 503 : 200).end('{}');
    return;
  }
  if (req.url === '/v1/chat/completions') {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const w of ['<think>\n\n</think>\n\n', 'Ответ ', 'локальной ', 'модели.']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    return;
  }
  res.writeHead(404).end();
}).listen(port, '127.0.0.1');
