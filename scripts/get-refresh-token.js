/**
 * Run: node scripts/get-refresh-token.js
 * Starts a local server on port 3001, opens Google OAuth in your browser,
 * catches the callback automatically, and prints the refresh token.
 */
const http  = require('http');
const https = require('https');
const { exec } = require('child_process');

const CLIENT_ID     = '885667771490-i3l3n31g1frq848g87haavn91lb0rbia.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const PORT          = 3001;
const REDIRECT_URI  = `http://localhost:${PORT}/callback`;
const SCOPE         = 'https://www.googleapis.com/auth/webmasters.readonly';

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth' +
  '?client_id='    + encodeURIComponent(CLIENT_ID) +
  '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
  '&response_type=code' +
  '&scope='        + encodeURIComponent(SCOPE) +
  '&access_type=offline' +
  '&prompt=consent';

function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      code,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  REDIRECT_URI,
      grant_type:    'authorization_code',
    }).toString();

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path:     '/token',
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') { res.end(); return; }

  const code  = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<h2>Error: ${error}</h2><p>Close this tab and check the terminal.</p>`);
    server.close();
    console.error('\n✗ Google returned error:', error);
    process.exit(1);
  }

  if (!code) { res.end('No code'); return; }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h2>✓ Authorized! Check your terminal for the refresh token. You can close this tab.</h2>');
  server.close();

  const tokens = await exchangeCode(code);
  if (tokens.refresh_token) {
    console.log('\n✓ Success! Refresh token:\n');
    console.log(tokens.refresh_token);
    console.log('\nNow run these 3 commands in your terminal (inside the balboa-portfolio folder):\n');
    console.log(`cd "C:\\Users\\tomca\\Documents\\balboa-portfolio"`);
    console.log(`npx supabase secrets set GOOGLE_CLIENT_ID="${CLIENT_ID}"`);
    console.log(`npx supabase secrets set GOOGLE_CLIENT_SECRET="${CLIENT_SECRET}"`);
    console.log(`npx supabase secrets set GOOGLE_REFRESH_TOKEN="${tokens.refresh_token}"`);
  } else {
    console.error('\n✗ Token exchange failed:', JSON.stringify(tokens, null, 2));
  }
});

server.listen(PORT, () => {
  console.log(`\nWaiting for Google callback on port ${PORT}...`);
  console.log('\nOpening your browser now. Sign in with Tom.Calahan@gmail.com and click Allow.\n');
  // Open browser on Windows
  exec(`start "" "${authUrl}"`);
});
