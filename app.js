"use strict";
let BAR=62; // Current taskbar height in CSS pixels.
const canvas=document.getElementById("screen"),ctx=canvas.getContext("2d",{alpha:false,desynchronized:true}),
      statusEl=document.getElementById("status"),pinsEl=document.getElementById("pins"),metaEl=document.getElementById("meta");
let ws,decoder,config,ready=false,retry,recfg,frames=0,needKey=false,decErrs=0,batt=-1,temp=0,configTimer,frameTimer,connectTimer,hadSession=false,connectAttempt=0;
let gpsWatch=null,gpsWanted=false,lastGpsSent=0,lastGpsError="";
const show=s=>{document.getElementById("status-message").textContent=s;statusEl.classList.remove("hide")};
const sendJson=o=>{if(ws&&ws.readyState===1)ws.send(JSON.stringify(o))};

// Bounded, local-only history. Unacknowledged events survive failed connections/reloads.
const WEB_VERSION="web-3",wdKey="wstream-diag-v2",wdPage=Date.now().toString(36)+Math.random().toString(36).slice(2,7);
let wdSeq=0,wdHistory=[],wdPending=[],wdTimer,wdInFlight=false,wdAttemptStart=performance.now(),wdFirstPacket=false;
try{const saved=JSON.parse(localStorage.getItem(wdKey)||"{}");if(Array.isArray(saved.history))wdHistory=saved.history.slice(-200);if(Array.isArray(saved.pending))wdPending=saved.pending.slice(-200)}catch(e){}
function wdSave(){try{localStorage.setItem(wdKey,JSON.stringify({history:wdHistory,pending:wdPending}))}catch(e){}}
function wdLog(event,detail=""){
  try{
    const row={id:wdPage+":"+(++wdSeq),v:WEB_VERSION,time:Date.now(),attempt:connectAttempt,ms:Math.round(performance.now()-wdAttemptStart),event,detail:String(detail).replace(/[\r\n\t]/g," ").slice(0,180)};
    wdHistory.push(row);wdHistory=wdHistory.slice(-200);wdPending.push(row);wdPending=wdPending.slice(-200);wdSave();
    clearTimeout(wdTimer);wdTimer=setTimeout(wdFlush,0);
  }catch(e){} // Diagnostics must never interrupt the viewer.
}
function wdFlush(){
  if(wdInFlight||!wdPending.length||!ws||ws.readyState!==1)return;
  try{ws.send(JSON.stringify({diag:wdPending.slice(0,20)}));wdInFlight=true}catch(e){}
}
function wdAck(ids){
  if(!Array.isArray(ids))return;
  wdPending=wdPending.filter(r=>!ids.includes(r.id));wdInFlight=false;wdSave();
  clearTimeout(wdTimer);wdTimer=setTimeout(wdFlush,0);
}
function wdText(){return "wStream "+WEB_VERSION+" · 브라우저 연결 진단 (시각은 차량 브라우저 기준)\n"+wdHistory.map(r=>new Date(r.time).toISOString()+" ["+r.id+"] 시도="+r.attempt+" +"+r.ms+"ms "+r.event+" "+r.detail).join("\n")}

window.addEventListener("online",()=>wdLog("online"));
window.addEventListener("offline",()=>wdLog("offline"));
document.addEventListener("visibilitychange",()=>wdLog("visibility",document.visibilityState));
window.addEventListener("pagehide",()=>wdLog("pagehide"));
window.addEventListener("error",e=>wdLog("script_error",e.message||"unknown"));
window.addEventListener("unhandledrejection",e=>wdLog("promise_error",String(e.reason||"unknown")));
wdLog("page",WEB_VERSION+" visible="+document.visibilityState+" online="+navigator.onLine);

// The video is only the app area: canvas = window minus the on-page taskbar, so nothing is
// ever drawn under the bar. 배율(density) is chosen in the phone app, which multiplies the
// devicePixelRatio we report here.
function sendCfg(){
  const r=window.devicePixelRatio||1;
  let w=Math.round(innerWidth*r),h=Math.round(Math.max(1,innerHeight-BAR)*r);
  const m=Math.max(w,h);if(m>1920){const k=1920/m;w=Math.round(w*k);h=Math.round(h*k)}
  wdLog("resize_send",w+"x"+h+" dpr="+r);
  sendJson({resize:[w,h,Math.round(r*100)]});
}
let rz;window.addEventListener("resize",()=>{clearTimeout(rz);rz=setTimeout(sendCfg,400)});

document.getElementById("nav-back").onclick=()=>sendJson({nav:"back"});
document.getElementById("nav-home").onclick=()=>sendJson({nav:"home"});
document.getElementById("nav-apps").onclick=()=>sendJson({nav:"apps"});

function renderMeta(){
  const d=new Date();let s=d.getHours()+":"+String(d.getMinutes()).padStart(2,"0");
  if(batt>=0)s+="  "+batt+"%";
  if(temp>0)s+="  "+temp.toFixed(1)+"°C";
  metaEl.textContent=s;
}
setInterval(renderMeta,10000);renderMeta();

function applyTaskbarSize(value){
  const percent=Number.isFinite(value)?Math.max(70,Math.min(150,value)):100;
  const next=62*percent/100;
  if(Math.abs(BAR-next)<0.01)return;
  cancelTouches();
  document.documentElement.style.setProperty("--taskbar-scale",String(percent/100));
  BAR=next;
  sendCfg();
}
function renderStatus(o){
  applyTaskbarSize(o.taskbarPercent);
  batt=typeof o.batt==="number"?o.batt:-1;
  temp=typeof o.temp==="number"?o.temp:0;
  renderMeta();
  pinsEl.textContent="";
  for(const p of o.pins||[]){
    const img=new Image();img.src="data:image/png;base64,"+p.i;img.title=p.n||"";
    img.onclick=()=>sendJson({start:p.c});
    pinsEl.appendChild(img);
  }
}

function disconnectViewer(socket, message){
  if(ws!==socket)return;
  wdLog("disconnect",message);wdInFlight=false;
  cancelTouches();
  // Detach first: a delayed close from an obsolete socket must not reset a newer viewer.
  ws=null;
  socket.onopen=socket.onmessage=socket.onclose=socket.onerror=null;
  clearTimeout(connectTimer);clearTimeout(configTimer);clearTimeout(recfg);
  config=null;closeDecoder();syncCarGps(false);
  try{socket.close()}catch(e){}
  show(message);clearTimeout(retry);retry=setTimeout(connect,1000);
}
function connect(){
  cancelTouches();
  clearTimeout(retry);
  if(ws){
    const previous=ws;ws=null;
    previous.onopen=previous.onmessage=previous.onclose=previous.onerror=null;
    try{previous.close()}catch(e){}
  }
  clearTimeout(connectTimer);clearTimeout(configTimer);clearTimeout(recfg);
  config=null;closeDecoder();syncCarGps(false);
  connectAttempt++;
  wdAttemptStart=performance.now();wdFirstPacket=false;wdInFlight=false;
  wdLog("connect", "visible="+document.visibilityState+" online="+navigator.onLine);
  show(`휴대폰에 연결 중… · ${connectAttempt}회\n응답이 없으면 자동으로 다시 시도합니다`);
  let socket;
  try{socket=new WebSocket("wss://wstream.ddnsfree.com:34752/ws")}catch(e){
    wdLog("constructor_error",e?.message||String(e));
    show("연결을 시작하지 못했습니다 · 자동 재시도 중…");retry=setTimeout(connect,1000);return;
  }
  ws=socket;socket.binaryType="arraybuffer";
  // onopen may never fire while Wi-Fi/VPN is recovering. Start the deadline now.
  connectTimer=setTimeout(()=>{if(ws===socket)wdLog("connect_timeout","limit=8000ms state="+socket.readyState);disconnectViewer(socket,"휴대폰 응답 대기 시간 초과 · 다시 연결 중…")},8000);
  socket.onopen=()=>{
    if(ws!==socket)return;
    wdLog("open");
    clearTimeout(connectTimer);hadSession=true;show("휴대폰 연결됨 · 영상 준비 중…");sendCfg();
    configTimer=setTimeout(()=>{
      if(ws===socket&&!config){wdLog("config_timeout","limit=12000ms");disconnectViewer(socket,"영상 설정을 기다리는 중 · 다시 연결합니다…");}
    },12000);
  };
  socket.onmessage=e=>{
    if(ws!==socket)return;
    const u=new Uint8Array(e.data);
    if(!wdFirstPacket){wdFirstPacket=true;wdLog("first_packet","type="+u[0]+" bytes="+u.length)}
    if(u[0]===4){try{wdAck(JSON.parse(new TextDecoder().decode(u.subarray(1))))}catch(x){}return}
    if(u[0]===1)configure(JSON.parse(new TextDecoder().decode(u.subarray(1))));
    else if(u[0]===2)frame(u);
    else if(u[0]===3){try{renderStatus(JSON.parse(new TextDecoder().decode(u.subarray(1))))}catch(x){}}
  };
  socket.onclose=e=>{if(ws!==socket)return;wdLog("close","code="+e.code+" clean="+e.wasClean+" reason="+e.reason);disconnectViewer(socket,"연결이 끊겼습니다 · 자동으로 다시 연결 중…")};
  socket.onerror=()=>{if(ws!==socket)return;wdLog("socket_error","state="+socket.readyState);disconnectViewer(socket,"연결에 응답이 없습니다 · 자동으로 다시 연결 중…")};
}
function configure(c){
  wdLog("config_received",c.w+"x"+c.h);
  cancelTouches();
  clearTimeout(configTimer);config=c;syncCarGps(!!c.useCarGps);canvas.width=c.w;canvas.height=c.h;closeDecoder();needKey=true;
  if(!("VideoDecoder" in window)){wdLog("decoder_unsupported");show("이 브라우저는 WebCodecs VideoDecoder를 지원하지 않습니다");return}
  const csd=Uint8Array.from(atob(c.csd),x=>x.charCodeAt(0)),codec=codecFromCsd(csd);
  show(`영상 설정 수신 · ${c.w}×${c.h}\n${codec} · 첫 키프레임 대기 중…`);
  decoder=new VideoDecoder({output:v=>{decErrs=0;clearTimeout(frameTimer);ctx.drawImage(v,0,0,canvas.width,canvas.height);v.close();if(!ready){wdLog("first_frame",canvas.width+"x"+canvas.height);ready=true;statusEl.classList.add("hide")}},error:e=>{
    wdLog("decoder_error",e?.message||String(e));console.error(e);ready=false;needKey=true;closeDecoder();
    if(++decErrs>=6){show(`이 브라우저가 영상을 디코드하지 못합니다\n${c.w}×${c.h} · ${codec}\n`+(e?.message||e));return}
    show("영상 디코더 복구 중…\n"+(e?.message||e));
    if(config){clearTimeout(recfg);recfg=setTimeout(()=>configure(config),500)}sendJson({kf:1})}});
  const dc={codec,optimizeForLatency:true,avc:{format:"annexb"}};
  try{decoder.configure(dc)}catch(e){try{delete dc.avc;decoder.configure(dc)}catch(e2){wdLog("decoder_config_error",e2?.message||String(e2));show("코덱 설정 실패\n"+(e2?.message||e2));return}}
  sendJson({kf:1});
  clearTimeout(frameTimer); frameTimer=setTimeout(()=>{if(!ready){sendJson({kf:1});frameTimer=setTimeout(()=>{if(!ready)sendJson({kf:1})},1200)}},500);
}

// nStream-compatible design: the HTTPS browser supplies the vehicle/device position and the
// phone receives it over the existing control WebSocket. This build only records diagnostics;
// Android location injection is intentionally a separate, later step.
function syncCarGps(enabled){
  gpsWanted=enabled;
  if(!enabled){
    if(gpsWatch!==null&&navigator.geolocation){try{navigator.geolocation.clearWatch(gpsWatch)}catch(e){}}
    gpsWatch=null;lastGpsSent=0;return;
  }
  if(gpsWatch!==null)return;
  if(!navigator.geolocation){sendJson({gpsError:"이 브라우저는 위치정보를 지원하지 않습니다"});return}
  try{
    gpsWatch=navigator.geolocation.watchPosition(p=>{
      if(!gpsWanted)return;
      const now=Date.now();if(now-lastGpsSent<180)return;lastGpsSent=now;
      const c=p.coords,alt=Number.isFinite(c.altitude)?c.altitude:0,
            speed=Number.isFinite(c.speed)?c.speed:0,heading=Number.isFinite(c.heading)?c.heading:0;
      const flags=(Number.isFinite(c.altitude)?1:0)|(Number.isFinite(c.speed)?2:0)|(Number.isFinite(c.heading)?4:0);
      sendJson({gps:[c.latitude,c.longitude,alt,Number.isFinite(c.accuracy)?c.accuracy:0,speed,heading,p.timestamp||now,flags]});
    },e=>{
      const msg=`${e.code}: ${e.message||"위치 권한 오류"}`;
      if(msg!==lastGpsError){lastGpsError=msg;sendJson({gpsError:msg})}
    },{enableHighAccuracy:true,maximumAge:1000,timeout:10000});
  }catch(e){sendJson({gpsError:String(e&&e.message?e.message:e)})}
}
function codecFromCsd(u){for(let i=0;i+7<u.length;i++){let n=-1;if(u[i]===0&&u[i+1]===0&&u[i+2]===0&&u[i+3]===1)n=i+4;else if(u[i]===0&&u[i+1]===0&&u[i+2]===1)n=i+3;if(n>=0&&(u[n]&31)===7)return"avc1."+[u[n+1],u[n+2],u[n+3]].map(x=>x.toString(16).padStart(2,"0")).join("").toUpperCase()}return"avc1.42E01F"}
function frame(u){frames++;if(!decoder||decoder.state!=="configured")return;const key=!!u[1],dv=new DataView(u.buffer,u.byteOffset+2,8),ts=Number(dv.getBigUint64(0));
  if(key)needKey=false;else if(needKey)return;else if(decoder.decodeQueueSize>20){needKey=true;sendJson({kf:1});return}
  let data=u.subarray(10);if(key&&config?.csd){const c=Uint8Array.from(atob(config.csd),x=>x.charCodeAt(0)),all=new Uint8Array(c.length+data.length);all.set(c);all.set(data,c.length);data=all}
  try{decoder.decode(new EncodedVideoChunk({type:key?"key":"delta",timestamp:ts,data}))}catch(e){console.warn(e);needKey=true;sendJson({kf:1})}}
function closeDecoder(){ready=false;clearTimeout(frameTimer);if(decoder){try{decoder.close()}catch(e){}decoder=null}}
function toDisp(e){const r=canvas.getBoundingClientRect(),scale=Math.min(r.width/config.w,r.height/config.h),dw=config.w*scale,dh=config.h*scale,ox=r.left+(r.width-dw)/2,oy=r.top+(r.height-dh)/2;return[Math.max(0,Math.min(config.w-1,Math.round((e.clientX-ox)/scale))),Math.max(0,Math.min(config.h-1,Math.round((e.clientY-oy)/scale)))]}
// Keep Android pointer IDs stable for the entire gesture (browser IDs may be >31).
const touches=new Map();
let lastMove=0;
function sendTouch(action,index=0){
  sendJson({mt:{action,index,points:Array.from(touches.values(),p=>[p.id,p.x,p.y])}});
}
function cancelTouches(){
  if(touches.size)sendTouch(3);
  touches.clear();lastMove=0;
}
canvas.addEventListener("pointerdown",e=>{
  if(!config||!ready||!ws||ws.readyState!==1||touches.has(e.pointerId)||touches.size>=10)return;
  if(e.pointerType==="mouse"&&e.button!==0)return;
  e.preventDefault();
  let id=0;const used=new Set(Array.from(touches.values(),p=>p.id));while(used.has(id))id++;
  const[x,y]=toDisp(e);touches.set(e.pointerId,{id,x,y});
  try{canvas.setPointerCapture(e.pointerId)}catch(x){}
  sendTouch(touches.size===1?0:5,touches.size-1);
},{passive:false});
canvas.addEventListener("pointermove",e=>{
  const p=touches.get(e.pointerId);if(!p||!config)return;
  e.preventDefault();[p.x,p.y]=toDisp(e);
  const now=performance.now();if(now-lastMove<12)return;lastMove=now;sendTouch(2);
},{passive:false});
canvas.addEventListener("pointerup",e=>{
  const p=touches.get(e.pointerId);if(!p||!config)return;
  e.preventDefault();[p.x,p.y]=toDisp(e);
  sendTouch(touches.size===1?1:6,Array.from(touches.keys()).indexOf(e.pointerId));
  touches.delete(e.pointerId);
},{passive:false});
canvas.addEventListener("pointercancel",cancelTouches);
canvas.addEventListener("lostpointercapture",e=>{if(touches.has(e.pointerId))cancelTouches()});
canvas.addEventListener("contextmenu",e=>e.preventDefault());
window.addEventListener("blur",cancelTouches);
window.addEventListener("pagehide",cancelTouches);
document.addEventListener("visibilitychange",()=>{if(document.visibilityState!=="visible")cancelTouches()});
document.getElementById("retry").onclick=connect;
window.addEventListener("online",()=>{if(!ws||ws.readyState!==1)connect()});
connect();
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"){
  if(!ws||ws.readyState!==1)connect();else{sendCfg();sendJson({kf:1})}
}});
