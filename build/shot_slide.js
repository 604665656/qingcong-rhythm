/* 截一张 HARD 谱面的滑条画面，确认连线真的画出来了 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9449;
const PAGE = process.env.PAGE_URL || ('file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/'));
const PROF = path.join(os.tmpdir(), 'qcshot_' + Date.now());
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROF,
    '--allow-file-access-from-files', '--mute-audio',
    ...(process.env.NO_PROXY ? ['--no-proxy-server', '--proxy-bypass-list=*'] : []),
    '--window-size=1000,520', PAGE
  ], { stdio: 'ignore' });

  let ws;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await r.json();
      const pg = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; }
    } catch (e) {}
    await sleep(250);
  }
  if (!ws) { console.error('CDP 失败'); edge.kill(); process.exit(1); }
  let id = 0; const pend = new Map();
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const send = (m, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async e => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      return { __err: (d.exception && (d.exception.description || d.exception.value)) || d.text };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: PAGE });
  for (let i = 0; i < 80; i++) {
    if (await ev(`(document.readyState==='complete' && !!document.getElementById('loading')) ? 'ok':'w'`) === 'ok') break;
    await sleep(250);
  }
  await sleep(2200);

  // 直接切到 HARD 谱面的游戏页，把时间钉在有滑条的一段
  const r = await ev(`(function(){
    S.diff='hard';
    S.chart = chartFor('hard');
    S.slides = buildSlides(S.chart);
    S.screen='game'; S.playing=true; S.paused=false; S.dur=185; S.auto=false;
    S.judge={PERFECT:0,GREAT:0,GOOD:0,MISS:0}; S.combo=12; S.maxCombo=12; S.score=48210;
    S.accSum=0.92; S.accCount=1; S.fever=true;
    document.getElementById('loading').className='off';
    if(!S.accents) S.accents = SONG.accents || [];
    setScreen = function(){};            // 冻结切屏：否则 boot 完成后会把标题页推回来
    document.querySelectorAll('.screen').forEach(function(el){ el.classList.remove('on'); });
    document.getElementById('gameScreen').classList.add('on');
    resize();
    songTime = function(){ return 30.2; };   // 把时钟钉住，交给实时循环去画这一段
    drawPlayfield(30.2);
    updHud();
    return JSON.stringify({slides:S.slides.length, laneW:V.laneW, w:V.w, h:V.h});
  })()`);
  console.log('状态:', typeof r === 'string' ? r : JSON.stringify(r));

  const probe = await ev(`JSON.stringify({
    titleCls: document.getElementById('titleScreen').className,
    gameCls: document.getElementById('gameScreen').className,
    titleDisp: getComputedStyle(document.getElementById('titleScreen')).display,
    gameDisp: getComputedStyle(document.getElementById('gameScreen')).display,
    pfW: document.getElementById('playfield').width,
    pfdDisp: getComputedStyle(document.getElementById('playfield')).display
  })`);
  console.log('DOM:', probe);
  await sleep(400);
  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  const out = path.join(__dirname, 'slide_shot.png');
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('截图:', out, (fs.statSync(out).size / 1024).toFixed(0) + 'KB');
  edge.kill();
  process.exit(0);
})();
