const { spawn } = require('child_process');
const path = require('path'), os = require('os');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9445;
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const edge = spawn(EDGE, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(os.tmpdir(),'qcm2_'+Date.now()),
    '--allow-file-access-from-files','--mute-audio','--window-size=1280,860', PAGE], { stdio: 'ignore' });
  let ws, id=0, pend=new Map();
  for (let i=0;i<60;i++){ try{ const l=await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json();
    const pg=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl); if(pg){ws=new WebSocket(pg.webSocketDebuggerUrl);break;} }catch(e){} await sleep(250); }
  await new Promise(r=>ws.addEventListener('open',r));
  ws.addEventListener('message', ev=>{ const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);} });
  const send=(m,p={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
  const ev2=async x=>(await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true})).result.result.value;
  await send('Runtime.enable'); await send('Page.enable'); await sleep(2500);
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
  await sleep(800);
  console.log(await ev2(`(function(){
    function r(s){ var e=document.querySelector(s); if(!e) return null; var b=e.getBoundingClientRect();
      return {t:Math.round(b.top), b:Math.round(b.bottom), h:Math.round(b.height)}; }
    return JSON.stringify({vh:innerHeight,
      wrap:r('.title-wrap'), actions:r('.title-actions'), plat:r('.plat-row'), who:r('.who-wrap'),
      foot:r('.title-foot'), health:r('.title-foot .health'), copy:r('.title-foot .copy'),
      screenOverflow: document.getElementById('titleScreen').scrollHeight - document.getElementById('titleScreen').clientHeight
    }, null, 1);
  })()`));
  ws.close(); edge.kill(); setTimeout(()=>process.exit(0),200);
})();
