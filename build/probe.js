const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9442;
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const edge = spawn(EDGE, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(os.tmpdir(),'qcp_'+Date.now()),
    '--allow-file-access-from-files','--mute-audio','--window-size=1280,860', PAGE], { stdio: 'ignore' });

  let ws, id = 0, pend = new Map(), logs = [];
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await r.json();
      const pg = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; }
    } catch (e) {}
    await sleep(250);
  }
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push('[console.' + m.params.type + '] ' + m.params.args.map(a => a.value !== undefined ? a.value : (a.description || a.type)).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[exception] ' + ((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text));
    }
  });
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) return 'ERR: ' + ((r.result.exceptionDetails.exception||{}).description || r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(4000);

  console.log('--- logs ---');
  console.log(logs.join('\n') || '(无)');

  console.log('\n--- probe ---');
  console.log('title-actions html:', String(await evaluate(`(document.querySelector('.title-actions')||{outerHTML:'NULL'}).outerHTML`)).slice(0, 400));
  console.log('title-foot exists:', await evaluate(`!!document.querySelector('.title-foot')`));
  console.log('PLAT ready:', await evaluate(`window.PLAT && PLAT.ready`));
  console.log('PLAT inToy:', await evaluate(`window.PLAT && PLAT.inToy`));
  console.log('PLAT user:', await evaluate(`JSON.stringify(window.PLAT && PLAT.user)`));
  console.log('PLAT cloudOk:', await evaluate(`window.PLAT && PLAT.cloudOk`));
  console.log('stam:', await evaluate(`JSON.stringify(window.PLAT && PLAT.stam)`));
  console.log('funcs:', await evaluate(`typeof window.__beforeStart + '/' + typeof window.__onFinish + '/' + typeof window.__onBoot`));
  console.log('body children ids:', await evaluate(`[].map.call(document.body.children, e=>e.id||e.className).join(',')`));

  ws.close(); edge.kill();
  setTimeout(() => process.exit(0), 200);
})();
