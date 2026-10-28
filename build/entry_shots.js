// 1024 参赛投稿用截图：标题页 / 竖屏游戏内 / 横屏游戏内 / 排行榜 / 装扮页
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9451;
const OUT = path.resolve(__dirname, '..', 'deliver', '投稿素材');
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const edge = spawn(EDGE, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(os.tmpdir(),'qce_'+Date.now()),
    '--allow-file-access-from-files','--mute-audio','--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required','--window-size=1280,860', PAGE], { stdio: 'ignore' });

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
    const p = path.join(OUT, name);
    fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
    console.log('shot', p, (fs.statSync(p).size / 1024).toFixed(0) + 'KB');
  };

  await send('Runtime.enable'); await send('Page.enable');
  await sleep(2500);

  // ① 竖屏标题页
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(1200);
  await shot('01_竖屏_标题页.png');

  // ② 竖屏游戏内（自动按键制造连击与分数）
  // headless 无声卡时 WebAudio 时钟不推进，截图前强制走 clock 时间源
  await ev(`try{ audioMode='clock'; }catch(e){} S.auto=true; S.diff='normal'; document.getElementById('startBtn').click();`);
  await sleep(1200);
  await ev(`var mc=document.getElementById('modeClose'); if(mc) mc.click();`);
  await sleep(46000);
  console.log('diag', await ev(`JSON.stringify({screen:S.screen,mode:(typeof audioMode!=='undefined')?audioMode:'?',st:songTime().toFixed(2),score:S.score,combo:S.combo,notes:document.querySelectorAll('.note').length})`));
  await shot('02_竖屏_游戏内.png');
  await ev(`if(S.screen==='game'&&!S.paused) pause();`);

  // ③ 排行榜（B 站榜单）
  await ev(`document.getElementById('pauseOverlay').classList.remove('on'); setScreen('title');`);
  await sleep(600);
  await ev(`document.getElementById('rankBtn').click();`);
  await sleep(1500);
  await shot('03_竖屏_排行榜.png');
  await ev(`document.getElementById('rankOverlay').classList.remove('on');`);

  // ④ 装扮页（B 站身份卡 + 预置弹幕）
  await ev(`setScreen('title'); try{document.getElementById('dressBtn').click()}catch(e){}`);
  await sleep(1200);
  await shot('04_竖屏_装扮与身份.png');
  await ev(`document.getElementById('dressOverlay').classList.remove('on');`);

  // ⑤ 横屏游戏内
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
  await sleep(900);
  await ev(`try{ audioMode='clock'; }catch(e){} S.auto=true; S.diff='normal'; document.getElementById('startBtn').click();`);
  await sleep(1000);
  await ev(`var mc=document.getElementById('modeClose'); if(mc) mc.click();`);
  await sleep(24000);
  await shot('05_横屏_游戏内.png');

  ws.close(); edge.kill();
  setTimeout(() => process.exit(0), 200);
})();
