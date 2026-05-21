const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const TARGET = 'voip.flightdev.ru';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

const server = http.createServer((req, res) => {
  // Always set CORS headers first
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS' || req.method === 'HEAD') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  console.log(`→ ${req.method} ${req.url}`);

  let body = [];
  req.on('data', chunk => body.push(chunk));
  req.on('end', () => {
    body = Buffer.concat(body);

    const options = {
      hostname: TARGET,
      port: 443,
      path: req.url,
      method: req.method,
      headers: {
        'Host': TARGET,
        'User-Agent': 'flightintercom1/5 CFNetwork/1496.0.7 Darwin/23.5.0',
        'Accept': '*/*',
        'Accept-Language': 'ru',
        'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded',
        'Content-Length': body.length,
      }
    };

    const proxyReq = https.request(options, (proxyRes) => {
      const headers = {
        ...CORS_HEADERS,
        'Content-Type': proxyRes.headers['content-type'] || 'application/json',
      };
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (e) => {
      console.error('Error:', e.message);
      res.writeHead(502, CORS_HEADERS);
      res.end(JSON.stringify({ error: e.message }));
    });

    if (body.length) proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(PORT, () => {
  console.log(`✓ Proxy running on port ${PORT}`);
});
