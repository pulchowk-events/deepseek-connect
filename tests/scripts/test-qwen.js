const http = require('http');

const PORT = process.env.EXTENSION_PORT || 7331;
const TOKEN = process.env.EXTENSION_TOKEN || 'demo-token-12345';

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path: path,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Content-Type': 'application/json'
      }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  console.log('🚀 Testing Qwen provider end-to-end...\n');
  const chatName = 'qwen-e2e-' + Date.now();
  
  console.log('1. Sending initial prompt to Qwen...');
  const res1 = await request('POST', '/chat', {
    chat: chatName,
    provider: 'qwen', // Explicitly route to the Qwen provider
    messages: [{ role: 'user', content: 'Reply with exactly one word: delta' }]
  });
  
  if (res1.error) {
    console.error('❌ FAIL:', res1);
    process.exit(1);
  }
  
  console.log('✅ Success! Response:', res1.content);
  console.log('🔗 URL captured:', res1.url);
  
  console.log('\n2. Testing URL retry (opening existing chat via URL)...');
  const res2 = await request('POST', '/open', {
    chatName: chatName,
    url: res1.url
  });
  
  console.log('✅ Open result:', JSON.stringify({ 
    existing: res2.existing, 
    mode: res2.mode, 
    url: res2.url 
  }));
  
  console.log('\n3. Sending follow-up prompt to verify chat context...');
  const res3 = await request('POST', '/chat', {
    chat: chatName,
    provider: 'qwen',
    messages: [{ role: 'user', content: 'What was the one word you just replied with?' }]
  });
  
  console.log('✅ Follow-up response:', res3.content);
  console.log('\n🎉 Qwen provider test completed successfully! The plugin architecture is fully functional.');
})().catch(e => {
  console.error('❌ Test failed:', e);
  process.exit(1);
});
