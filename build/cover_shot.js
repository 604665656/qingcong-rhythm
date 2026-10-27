const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9447;
const PAGE = 'file:///' + path.resolve(__dirname, 'cover_4x3.html').replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const edge = spawn(EDGE, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(os.tmpdir(),'qcc_'+Date.now()),
    '--allow-file-access-from-files','--hide-scrollbars','--force-device-scale-factor=1',
    '--window-size=1200,900', PAGE], { stdio: 'ignore' });
  let ws, id=0, pend=new Map();
  for (let i=0;i<60;i++){ try{ const l=await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json();
    const pg=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl); if(pg){ws=new WebSocket(pg.webSocketDebuggerUrl);break;} }catch(e){} await sleep(250); }
  await new Promise(r=>ws.addEventListener('open',r));
  ws.addEventListener('message', ev=>{ const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);} });
  const send=(m,p={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1200,height:900,deviceScaleFactor:1,mobile:false});
  await sleep(1400);
  const r = await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,clip:{x:0,y:0,width:1200,height:900,scale:1}});
  const out = path.resolve(__dirname,'../deliver/封面_1200x900.png');
  fs.writeFileSync(out, Buffer.from(r.result.data,'base64'));
  console.log('saved', out, (fs.statSync(out).size/1024).toFixed(0)+'KB');
  ws.close(); edge.kill(); setTimeout(()=>process.exit(0),200);
})();
