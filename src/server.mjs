import { createServer } from 'node:http';
const server = createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({status:'ok'})); return; }
  res.writeHead(404); res.end();
});
server.listen(process.env.PORT || 3000);
