const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9443;
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const edge = spawn(EDGE, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(os.tmpdir(),'qcs_'+Date.now()),
    '--allow-file-access-from-files','--mute-audio','--window-size=1280,860', PAGE], { stdio: 'ignore' });

  let ws, id = 0, pend = new Map();
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const pg = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; }
    } catch (e) {}
    await sleep(250);
  }
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.result.data, 'base64'));
    console.log('shot', name);
  };

  await send('Runtime.enable'); await send('Page.enable');
  await sleep(2500);

  // 竖屏 390x844
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(900);
  await shot('shot_portrait_title.png');

  // 竖屏游戏内
  await ev(`S.diff='easy'; document.getElementById('startBtn').click();`);
  await sleep(1600);
  await shot('shot_portrait_game.png');
  await ev(`if(S.screen==='game'&&!S.paused) pause();`);
  await sleep(300);

  // 横屏 844x390
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
  await sleep(1200);
  await ev(`document.getElementById('pauseOverlay').classList.remove('on'); setScreen('title');`);
  await sleep(500);
  await shot('shot_landscape_title.png');

  await ev(`S.diff='normal'; document.getElementById('startBtn').click();`);
  await sleep(1600);
  await shot('shot_landscape_game.png');
  await ev(`if(S.screen==='game'&&!S.paused) pause();`);
  await sleep(300);

  // 排行榜弹层（竖屏）
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(700);
  await ev(`document.getElementById('pauseOverlay').classList.remove('on'); setScreen('title'); document.getElementById('rankBtn').click();`);
  await sleep(1200);
  await shot('shot_portrait_rank.png');
  await ev(`document.getElementById('rankOverlay').classList.remove('on'); document.getElementById('staminaPill').click();`);
  await sleep(600);
  await shot('shot_portrait_stamina.png');

  // 老板键
  await ev(`document.getElementById('stamOverlay').classList.remove('on'); document.dispatchEvent(new KeyboardEvent('keydown',{key:'x',code:'KeyX',altKey:true,bubbles:true}));`);
  await sleep(600);
  await shot('shot_boss.png');

  // 桌面
  await send('Emulation.clearDeviceMetricsOverride');
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'x',code:'KeyX',altKey:true,bubbles:true}));`);
  await sleep(800);
  await shot('shot_desktop_title.png');

  ws.close(); edge.kill();
  setTimeout(() => process.exit(0), 200);
})();
