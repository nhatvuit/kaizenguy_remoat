const http = require('http');
const WebSocket = require('ws');

http.get('http://127.0.0.1:9222/json/list', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        try {
            const targets = JSON.parse(data);
            const cascade = targets.find((t) => t.url && t.url.includes('workbench-jetski-agent.html'));
            if (!cascade) {
                console.log('No workbench context found');
                return;
            }
            
            const ws = new WebSocket(cascade.webSocketDebuggerUrl);
            ws.on('open', () => {
                ws.send(JSON.stringify({
                    id: 1,
                    method: 'Runtime.evaluate',
                    params: {
                        expression: `
                            (function() {
                                const els = document.querySelectorAll('div, button, a, span');
                                const matches = [];
                                for (const el of els) {
                                  const text = (el.textContent || '').trim().toLowerCase();
                                  if (text.includes('claude') || text.includes('gemini') || text.includes('gpt')) {
                                     matches.push({
                                        tag: el.tagName,
                                        class: el.className,
                                        text: text.substring(0, 80),
                                        offsetParent: el.offsetParent ? 'yes' : 'no'
                                     });
                                  }
                                }
                                return matches;
                            })()
                        `,
                        returnByValue: true
                    }
                }));
            });
            
            ws.on('message', (msg) => {
                const parsed = JSON.parse(msg);
                if (parsed.id === 1) {
                    console.log('Elements:', JSON.stringify(parsed.result.result.value, null, 2));
                    process.exit(0);
                }
            });
        } catch (e) {
            console.error(e);
        }
    });
});
