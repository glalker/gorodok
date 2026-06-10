'use strict';

// ---------- состояние ----------
let ws = null;
let myId = null;
let world = { w: 2200, h: 1400 };
let METER = 32; // пикселей в «метре», приходит с сервера
let roomName = '';
const players = new Map();   // id -> {id,name,status,x,y,hue,voice, rx,ry, anim, lastX,lastY}
const bubbles = new Map();   // id -> {text, at}
let clusters = [];           // [{ids,topic,x,y}]
const stones = [];           // летящие камни [{x0,y0,x1,y1,ms,t0}]
const effects = [];          // визуальные эффекты [{type,...,at}]
let myStunnedUntil = 0;      // после попадания камнем — оглушение

const $ = id => document.getElementById(id);
const cv = $('cv');
const ctx = cv.getContext('2d');
const isTouch = 'ontouchstart' in window;

// ---------- экран входа ----------
fetch('/rooms').then(r => r.json()).then(list => {
  const dl = $('roomList');
  dl.innerHTML = list.map(r => `<option value="${escapeHtml(r.name)}">`).join('');
  const online = list.filter(r => r.count > 0);
  if (online.length) {
    $('roomsOnline').textContent = 'Сейчас живые городки: ' +
      online.map(r => `${r.name} (${r.count})`).join(', ');
  }
}).catch(() => {});

$('joinBtn').onclick = () => join($('roomInput').value.trim() || 'Городок');

$('geoBtn').onclick = () => {
  if (!navigator.geolocation) { alert('Геолокация недоступна в этом браузере'); return; }
  $('geoBtn').textContent = '📍 Ищу тебя на карте…';
  navigator.geolocation.getCurrentPosition(
    pos => join('гео-' + geohash(pos.coords.latitude, pos.coords.longitude, 6)),
    () => {
      $('geoBtn').textContent = '📍 Городок рядом со мной';
      alert('Не удалось получить геолокацию. Разреши доступ или зайди в обычный городок.');
    },
    { timeout: 8000 }
  );
};

function join(room) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    ws.send(JSON.stringify({
      t: 'join', room,
      name: $('nameInput').value,
      status: $('statusInput').value,
      radius: +$('radiusInput').value,
    }));
  };
  ws.onmessage = e => handleMsg(JSON.parse(e.data));
  ws.onclose = () => {
    if (myId !== null) location.reload();
  };
}

// ---------- сообщения сервера ----------
function handleMsg(m) {
  switch (m.t) {
    case 'welcome':
      myId = m.id;
      world = m.world;
      METER = m.meter || 32;
      roomName = m.room;
      for (const p of m.players) addPlayer(p);
      startGame();
      break;
    case 'player_join':
      addPlayer(m.p);
      logLine(`${m.p.name} зашёл в городок`);
      updateOnline();
      break;
    case 'player_leave': {
      const p = players.get(m.id);
      if (p) logLine(`${p.name} ушёл`);
      players.delete(m.id);
      bubbles.delete(m.id);
      closePeer(m.id);
      updateOnline();
      break;
    }
    case 'move': {
      const p = players.get(m.id);
      if (p) { p.x = m.x; p.y = m.y; }
      break;
    }
    case 'chat': {
      bubbles.set(m.id, { text: m.text, at: performance.now() });
      const p = players.get(m.id);
      if (p) logLine(`${p.name}: ${m.text}`);
      break;
    }
    case 'status': {
      const p = players.get(m.id);
      if (p) p.status = m.text;
      break;
    }
    case 'voice': {
      const p = players.get(m.id);
      if (p) p.voice = m.on;
      if (m.on && voiceOn) ensurePeer(m.id);
      if (!m.on) closePeer(m.id);
      break;
    }
    case 'rtc':
      handleRtc(m.from, m.data);
      break;
    case 'radius': {
      const p = players.get(m.id);
      if (p) p.radius = m.v;
      break;
    }
    case 'jump': {
      const p = players.get(m.id);
      if (p) p.jumpStart = performance.now();
      break;
    }
    case 'throw':
      stones.push({ ...m, t0: performance.now() });
      break;
    case 'hit': {
      const p = players.get(m.id);
      const by = players.get(m.by);
      if (p) p.hitAt = performance.now();
      effects.push({ type: 'stars', id: m.id, at: performance.now() });
      if (p && by) logLine(`🪨 ${by.name} попал в ${p.name}!`);
      if (m.id === myId && p) {
        myStunnedUntil = performance.now() + 800;
        const d = Math.hypot(p.x - m.x, p.y - m.y) || 1;
        p.x = Math.max(0, Math.min(world.w, p.x + (p.x - m.x) / d * 38));
        p.y = Math.max(0, Math.min(world.h, p.y + (p.y - m.y) / d * 38));
        ws.send(JSON.stringify({ t: 'move', x: p.x, y: p.y }));
      }
      break;
    }
    case 'dodge': {
      const p = players.get(m.id);
      if (p) logLine(`😎 ${p.name} увернулся в прыжке!`);
      break;
    }
    case 'clusters':
      clusters = m.clusters;
      break;
  }
}

function addPlayer(p) {
  players.set(p.id, { ...p, rx: p.x, ry: p.y, anim: 0, lastX: p.x, lastY: p.y });
  if (voiceOn && p.voice && p.id !== myId) ensurePeer(p.id);
}

function me() { return players.get(myId); }

// ---------- старт игры ----------
function startGame() {
  $('join').hidden = true;
  $('game').hidden = false;
  $('roomLabel').textContent = '🏘️ ' + roomName;
  const rm = Math.round((me().radius || 8 * METER) / METER);
  $('radiusBarInput').value = rm;
  $('radiusBarVal').textContent = rm + 'м';
  updateOnline();
  if (isTouch) {
    $('joystick').hidden = false;
    $('jumpBtn').hidden = false;
  }
  logLine(isTouch
    ? 'Тап по полю — бросить камень 🪨, кнопка ⬆️ — прыжок'
    : 'Пробел — прыжок, клик по полю — бросить камень 🪨');
  resize();
  buildDecor();
  requestAnimationFrame(frame);
}

$('jumpBtn').addEventListener('pointerdown', e => {
  e.preventDefault();
  e.stopPropagation();
  doJump();
});

function updateOnline() {
  $('onlineLabel').textContent = `онлайн: ${players.size}`;
}

window.addEventListener('resize', resize);
function resize() {
  const dpr = window.devicePixelRatio || 1;
  cv.width = innerWidth * dpr;
  cv.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ---------- управление ----------
// e.code — физическая клавиша, не зависит от раскладки (ru/en)
const KEYMAP = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};
const keys = { up: false, down: false, left: false, right: false };
function releaseAllKeys() { keys.up = keys.down = keys.left = keys.right = false; }

addEventListener('keydown', e => {
  if (document.activeElement === $('chatInput')) {
    if (e.key === 'Escape') $('chatInput').blur();
    return;
  }
  if (e.key === 'Enter') { $('chatInput').focus(); e.preventDefault(); return; }
  if (e.code === 'Space') { doJump(); e.preventDefault(); return; }
  const dir = KEYMAP[e.code];
  if (dir) { keys[dir] = true; e.preventDefault(); }
});
addEventListener('keyup', e => {
  const dir = KEYMAP[e.code];
  if (dir) keys[dir] = false;
});
// чтобы клавиши не «залипали» при потере фокуса или смене вкладки
addEventListener('blur', releaseAllKeys);
document.addEventListener('visibilitychange', releaseAllKeys);

let joyVec = { x: 0, y: 0 };
const joy = $('joystick'), stick = $('stick');
joy.addEventListener('touchstart', joyMove, { passive: false });
joy.addEventListener('touchmove', joyMove, { passive: false });
joy.addEventListener('touchend', () => { joyVec = { x: 0, y: 0 }; stick.style.left = '35px'; stick.style.top = '35px'; });
function joyMove(e) {
  e.preventDefault();
  const r = joy.getBoundingClientRect();
  const t = e.touches[0];
  let dx = t.clientX - (r.left + r.width / 2);
  let dy = t.clientY - (r.top + r.height / 2);
  const len = Math.hypot(dx, dy) || 1;
  const max = r.width / 2 - 20;
  if (len > max) { dx = dx / len * max; dy = dy / len * max; }
  joyVec = { x: dx / max, y: dy / max };
  stick.style.left = (35 + dx) + 'px';
  stick.style.top = (35 + dy) + 'px';
}

// ---------- прыжок и камни ----------
function doJump() {
  const p = me();
  if (!p || !ws) return;
  if (p.jumpStart && performance.now() - p.jumpStart < 650) return;
  p.jumpStart = performance.now();
  ws.send(JSON.stringify({ t: 'jump' }));
}

let lastThrowSent = -9999;
cv.addEventListener('pointerdown', e => {
  if (!myId) return;
  const now = performance.now();
  if (now - lastThrowSent < 1100) return;
  lastThrowSent = now;
  const { cx, cy } = camera();
  ws.send(JSON.stringify({ t: 'throw', tx: e.clientX + cx, ty: e.clientY + cy }));
});

let lastSent = 0;
function updateMovement(dt) {
  const p = me();
  if (!p) return;
  if (performance.now() < myStunnedUntil) return; // оглушён камнем
  let dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  let dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
  dx += joyVec.x; dy += joyVec.y;
  const len = Math.hypot(dx, dy);
  if (len > 1) { dx /= len; dy /= len; }
  if (len > 0.05) {
    const SPEED = 230;
    p.x = Math.max(0, Math.min(world.w, p.x + dx * SPEED * dt));
    p.y = Math.max(0, Math.min(world.h, p.y + dy * SPEED * dt));
    const now = performance.now();
    if (now - lastSent > 70) {
      lastSent = now;
      ws.send(JSON.stringify({ t: 'move', x: p.x, y: p.y }));
    }
  }
}

// ---------- чат ----------
$('chatForm').onsubmit = e => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) { $('chatInput').blur(); return; }
  ws.send(JSON.stringify({ t: 'chat', text }));
  bubbles.set(myId, { text, at: performance.now() });
  logLine(`${me().name}: ${text}`);
  $('chatInput').value = '';
  $('chatInput').blur();
};

function logLine(text) {
  const log = $('log');
  const div = document.createElement('div');
  div.textContent = text;
  log.appendChild(div);
  while (log.children.length > 6) log.removeChild(log.firstChild);
  setTimeout(() => { if (div.parentNode) div.remove(); }, 14000);
}

// ---------- статус ----------
$('statusBtn').onclick = () => {
  const cur = me() ? me().status : '';
  const text = prompt('Твой статус (видно всем над головой):', cur);
  if (text === null) return;
  me().status = text.trim().slice(0, 90);
  ws.send(JSON.stringify({ t: 'status', text: me().status }));
};

$('leaveBtn').onclick = () => location.reload();

// ---------- радиус слышимости ----------
$('radiusInput').oninput = () => { $('radiusVal').textContent = $('radiusInput').value; };
$('radiusBarInput').oninput = () => {
  const v = +$('radiusBarInput').value;
  $('radiusBarVal').textContent = v + 'м';
  if (me()) {
    me().radius = v * METER;
    ws.send(JSON.stringify({ t: 'radius', v }));
  }
};

// ---------- голос (WebRTC, громкость по расстоянию) ----------
let voiceOn = false;
let localStream = null;
const peers = new Map(); // id -> {pc, audio}

$('voiceBtn').onclick = async () => {
  if (!voiceOn) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Микрофон доступен только по https (или на localhost). Открой сайт по https-ссылке.');
      return;
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      alert('Нет доступа к микрофону: ' + e.name + '. Разреши доступ в настройках браузера.');
      return;
    }
    voiceOn = true;
    me().voice = true;
    $('voiceBtn').classList.add('on');
    ws.send(JSON.stringify({ t: 'voice', on: true }));
    for (const p of players.values()) {
      if (p.id !== myId && p.voice) ensurePeer(p.id);
    }
  } else {
    voiceOn = false;
    me().voice = false;
    $('voiceBtn').classList.remove('on');
    ws.send(JSON.stringify({ t: 'voice', on: false }));
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    for (const id of [...peers.keys()]) closePeer(id);
  }
};

function ensurePeer(id) {
  if (peers.has(id) || !voiceOn || id === myId) return;
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      // бесплатный TURN на случай строгих NAT (мобильные сети в разных городах)
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
  });
  const audio = new Audio();
  audio.autoplay = true;
  peers.set(id, { pc, audio });

  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.ontrack = e => {
    audio.srcObject = e.streams[0];
    audio.play().catch(() => {});
  };
  pc.onicecandidate = e => {
    if (e.candidate) ws.send(JSON.stringify({ t: 'rtc', to: id, data: { cand: e.candidate } }));
  };
  // инициатор — тот, у кого id меньше (чтобы не было двойных offer)
  if (myId < id) {
    pc.onnegotiationneeded = async () => {
      await pc.setLocalDescription(await pc.createOffer());
      ws.send(JSON.stringify({ t: 'rtc', to: id, data: { sdp: pc.localDescription } }));
    };
  }
}

async function handleRtc(from, data) {
  if (!voiceOn) return;
  ensurePeer(from);
  const peer = peers.get(from);
  if (!peer) return;
  try {
    if (data.sdp) {
      await peer.pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        ws.send(JSON.stringify({ t: 'rtc', to: from, data: { sdp: peer.pc.localDescription } }));
      }
    } else if (data.cand) {
      await peer.pc.addIceCandidate(data.cand);
    }
  } catch (e) { console.warn('rtc', e); }
}

function closePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.pc.close();
  peer.audio.srcObject = null;
  peers.delete(id);
}

function updateVoiceVolumes() {
  const my = me();
  if (!my) return;
  for (const [id, peer] of peers) {
    const p = players.get(id);
    if (!p) continue;
    const d = Math.hypot(p.rx - my.x, p.ry - my.y);
    const v = Math.max(0, 1 - d / (p.radius || 8 * METER)); // радиус говорящего
    peer.audio.volume = v * v; // тише с расстоянием
  }
}

// ---------- декорации (детерминированные по имени комнаты) ----------
let decor = [];
function buildDecor() {
  const rnd = mulberry32(hashStr(roomName));
  decor = [];
  for (let i = 0; i < 42; i++) {
    decor.push({ type: 'tree', x: rnd() * world.w, y: rnd() * world.h, s: 0.7 + rnd() * 0.7 });
  }
  for (let i = 0; i < 26; i++) {
    decor.push({ type: 'flower', x: rnd() * world.w, y: rnd() * world.h, hue: Math.floor(rnd() * 360) });
  }
  decor.push({ type: 'pond', x: world.w * (0.2 + rnd() * 0.6), y: world.h * (0.2 + rnd() * 0.6) });
}

// ---------- рендер ----------
let lastT = performance.now();
function frame(t) {
  const dt = Math.min(0.05, (t - lastT) / 1000);
  lastT = t;
  updateMovement(dt);

  // интерполяция чужих позиций
  for (const p of players.values()) {
    if (p.id === myId) { p.rx = p.x; p.ry = p.y; }
    else {
      p.rx += (p.x - p.rx) * Math.min(1, dt * 12);
      p.ry += (p.y - p.ry) * Math.min(1, dt * 12);
    }
    const sp = Math.hypot(p.rx - p.lastX, p.ry - p.lastY) / Math.max(dt, 0.001);
    p.anim += (sp > 15 ? dt * 11 : 0);
    p.lastX = p.rx; p.lastY = p.ry;
  }
  updateVoiceVolumes();
  draw(t);
  requestAnimationFrame(frame);
}

function camera() {
  const my = me();
  const vw = innerWidth, vh = innerHeight;
  let cx = (my ? my.rx : world.w / 2) - vw / 2;
  let cy = (my ? my.ry : world.h / 2) - vh / 2;
  cx = Math.max(-80, Math.min(world.w - vw + 80, cx));
  cy = Math.max(-80, Math.min(world.h - vh + 80, cy));
  if (world.w < vw) cx = (world.w - vw) / 2;
  if (world.h < vh) cy = (world.h - vh) / 2;
  return { cx, cy };
}

function draw(t) {
  const { cx, cy } = camera();
  const vw = innerWidth, vh = innerHeight;
  ctx.clearRect(0, 0, vw, vh);

  // трава
  ctx.fillStyle = '#7cb860';
  ctx.fillRect(0, 0, vw, vh);

  ctx.save();
  ctx.translate(-cx, -cy);

  // площадь и дорожки
  ctx.fillStyle = '#a9c98a';
  ctx.fillRect(0, world.h / 2 - 45, world.w, 90);
  ctx.fillRect(world.w / 2 - 45, 0, 90, world.h);
  ctx.beginPath();
  ctx.arc(world.w / 2, world.h / 2, 190, 0, Math.PI * 2);
  ctx.fill();

  // граница мира
  ctx.strokeStyle = 'rgba(40,70,30,.35)';
  ctx.lineWidth = 6;
  ctx.strokeRect(0, 0, world.w, world.h);

  // декорации
  for (const d of decor) {
    if (d.x < cx - 100 || d.x > cx + vw + 100 || d.y < cy - 100 || d.y > cy + vh + 100) continue;
    if (d.type === 'tree') drawTree(d);
    else if (d.type === 'flower') drawFlower(d);
    else if (d.type === 'pond') drawPond(d);
  }

  // круг слышимости вокруг меня (мой радиус — на сколько слышно МЕНЯ)
  const my = me();
  if (my) {
    ctx.beginPath();
    ctx.setLineDash([10, 12]);
    ctx.strokeStyle = 'rgba(255,255,255,.45)';
    ctx.lineWidth = 2;
    ctx.arc(my.rx, my.ry, my.radius || 8 * METER, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // игроки снизу вверх по y
  const sorted = [...players.values()].sort((a, b) => a.ry - b.ry);
  for (const p of sorted) drawPlayer(p, t);

  drawStones(t);
  drawEffects(t);

  // темы групп
  for (const c of clusters) {
    if (!c.topic) continue;
    drawTopic(c);
  }

  ctx.restore();
}

function drawTree(d) {
  ctx.fillStyle = '#7a5a36';
  ctx.fillRect(d.x - 4 * d.s, d.y - 8 * d.s, 8 * d.s, 16 * d.s);
  ctx.beginPath();
  ctx.fillStyle = '#4d8a3d';
  ctx.arc(d.x, d.y - 22 * d.s, 20 * d.s, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.fillStyle = '#5fa14b';
  ctx.arc(d.x - 9 * d.s, d.y - 14 * d.s, 13 * d.s, 0, Math.PI * 2);
  ctx.arc(d.x + 9 * d.s, d.y - 14 * d.s, 13 * d.s, 0, Math.PI * 2);
  ctx.fill();
}

function drawFlower(d) {
  ctx.beginPath();
  ctx.fillStyle = `hsl(${d.hue} 70% 70%)`;
  ctx.arc(d.x, d.y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.fillStyle = '#ffe28a';
  ctx.arc(d.x, d.y, 1.7, 0, Math.PI * 2);
  ctx.fill();
}

function drawPond(d) {
  ctx.beginPath();
  ctx.fillStyle = '#6ca8c9';
  ctx.ellipse(d.x, d.y, 110, 62, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(255,255,255,.4)';
  ctx.lineWidth = 2;
  ctx.ellipse(d.x, d.y, 96, 50, 0, 0, Math.PI * 2);
  ctx.stroke();
}

function drawPlayer(p, t) {
  const x = p.rx;
  const my = me();
  const d = my ? Math.hypot(x - my.rx, p.ry - my.ry) : 0;
  const R = p.radius || 8 * METER; // радиус говорящего: слышно ли МНЕ его
  const far = d > R;
  const alpha = p.id === myId ? 1 : (far ? 0.55 : 1);

  // высота прыжка
  let z = 0;
  if (p.jumpStart) {
    const jk = (t - p.jumpStart) / 650;
    if (jk < 1) z = Math.sin(Math.PI * jk) * 26;
    else p.jumpStart = 0;
  }
  const y = p.ry - z;       // тело в воздухе
  const gy = p.ry;          // тень на земле

  ctx.save();
  ctx.globalAlpha = alpha;

  // тень (меньше в прыжке)
  ctx.beginPath();
  ctx.fillStyle = 'rgba(0,0,0,.18)';
  ctx.ellipse(x, gy + 2, Math.max(6, 12 - z * 0.2), Math.max(3, 5 - z * 0.08), 0, 0, Math.PI * 2);
  ctx.fill();

  // стикмен
  const c = `hsl(${p.hue} 55% 30%)`;
  const swing = Math.sin(p.anim) * 7;
  const legSpread = z > 2 ? 9 : 6; // в прыжке ноги поджаты в стороны
  ctx.strokeStyle = c;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  // ноги
  ctx.beginPath();
  ctx.moveTo(x, y - 14); ctx.lineTo(x - legSpread + swing * 0.5, y - (z > 2 ? 4 : 0));
  ctx.moveTo(x, y - 14); ctx.lineTo(x + legSpread - swing * 0.5, y - (z > 2 ? 4 : 0));
  // тело
  ctx.moveTo(x, y - 14); ctx.lineTo(x, y - 30);
  // руки (в прыжке — вверх)
  if (z > 2) {
    ctx.moveTo(x - 10, y - 34); ctx.lineTo(x, y - 27);
    ctx.lineTo(x + 10, y - 34);
  } else {
    ctx.moveTo(x - 9, y - 22 + swing * 0.4); ctx.lineTo(x, y - 27);
    ctx.lineTo(x + 9, y - 22 - swing * 0.4);
  }
  ctx.stroke();
  // голова
  ctx.beginPath();
  ctx.fillStyle = '#ffe3c2';
  ctx.arc(x, y - 38, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // вспышка от попадания камнем
  if (p.hitAt && t - p.hitAt < 450) {
    ctx.font = '18px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('💥', x + 10, y - 30);
  }

  // имя
  ctx.font = '12px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,.75)';
  ctx.fillText(p.name + (p.voice ? ' 🎤' : ''), x, gy + 16);

  // статус над головой
  let topY = y - 52;
  if (p.status) {
    topY -= drawPill(x, topY, '💭 ' + p.status, 'rgba(255,255,255,.85)', '#3c4a33', 11);
  }

  // пузырь с сообщением
  const b = bubbles.get(p.id);
  if (b) {
    const age = (t - b.at) / 1000;
    if (age > 8) bubbles.delete(p.id);
    else {
      const fade = age > 6.5 ? 1 - (age - 6.5) / 1.5 : 1;
      const hearFade = far ? Math.max(0, 1 - (d - R) / (R * 0.4)) : 1;
      ctx.globalAlpha = alpha * fade * hearFade;
      drawBubble(x, topY - 4, b.text);
      ctx.globalAlpha = alpha;
    }
  }
  ctx.restore();
}

function drawPill(x, y, text, bg, fg, size) {
  ctx.font = `${size}px system-ui`;
  const w = Math.min(ctx.measureText(text).width + 14, 250);
  const h = size + 9;
  ctx.fillStyle = bg;
  roundRect(x - w / 2, y - h, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.fillText(truncate(text, 240), x, y - h / 2 + size / 2 - 1);
  return h + 4;
}

function drawBubble(x, y, text) {
  ctx.font = '13px system-ui';
  const lines = wrapText(text, 220);
  const lh = 17;
  const w = Math.min(Math.max(...lines.map(l => ctx.measureText(l).width)) + 18, 240);
  const h = lines.length * lh + 12;
  ctx.fillStyle = '#fff';
  roundRect(x - w / 2, y - h, w, h, 9);
  ctx.fill();
  // хвостик
  ctx.beginPath();
  ctx.moveTo(x - 5, y); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 7);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#222';
  ctx.textAlign = 'center';
  lines.forEach((l, i) => ctx.fillText(l, x, y - h + 18 + i * lh));
}

function drawStones(t) {
  for (let i = stones.length - 1; i >= 0; i--) {
    const s = stones[i];
    const k = (t - s.t0) / s.ms;
    if (k >= 1) {
      effects.push({ type: 'puff', x: s.x1, y: s.y1, at: t });
      stones.splice(i, 1);
      continue;
    }
    const x = s.x0 + (s.x1 - s.x0) * k;
    const y = s.y0 + (s.y1 - s.y0) * k;
    const d = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    const h = Math.sin(Math.PI * k) * Math.min(70, d * 0.3) + 24; // дуга от руки
    // тень камня
    ctx.beginPath();
    ctx.fillStyle = 'rgba(0,0,0,.15)';
    ctx.ellipse(x, y, 5, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
    // камень
    ctx.beginPath();
    ctx.fillStyle = '#8a8a8a';
    ctx.arc(x, y - h, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#5c5c5c';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawEffects(t) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    const age = t - e.at;
    if (e.type === 'puff') {
      if (age > 350) { effects.splice(i, 1); continue; }
      const k = age / 350;
      ctx.beginPath();
      ctx.strokeStyle = `rgba(110,95,75,${(1 - k).toFixed(2)})`;
      ctx.lineWidth = 2;
      ctx.arc(e.x, e.y, 4 + k * 14, 0, Math.PI * 2);
      ctx.stroke();
    } else if (e.type === 'stars') {
      if (age > 1000) { effects.splice(i, 1); continue; }
      const p = players.get(e.id);
      if (!p) { effects.splice(i, 1); continue; }
      const k = age / 1000;
      ctx.globalAlpha = 1 - k;
      ctx.font = '14px system-ui';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#f5c542';
      for (let j = 0; j < 3; j++) {
        const a = age / 150 + j * 2.1;
        ctx.fillText('✦', p.rx + Math.cos(a) * 16, p.ry - 52 + Math.sin(a) * 5);
      }
      ctx.globalAlpha = 1;
    }
  }
}

function drawTopic(c) {
  const ids = new Set(c.ids);
  // центр группы по актуальным позициям
  let sx = 0, sy = Infinity, n = 0;
  for (const id of ids) {
    const p = players.get(id);
    if (!p) continue;
    sx += p.rx; sy = Math.min(sy, p.ry); n++;
  }
  if (n < 2) return;
  const x = sx / n, y = sy - 92;
  ctx.font = 'bold 13px system-ui';
  const text = '💬 ' + c.topic;
  const w = Math.min(ctx.measureText(text).width + 22, 300);
  ctx.fillStyle = 'rgba(58,79,48,.88)';
  roundRect(x - w / 2, y - 26, w, 26, 13);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(truncate(text, 285), x, y - 8);
}

// ---------- утилиты ----------
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(text, maxW) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

function truncate(text, maxW) {
  while (ctx.measureText(text).width > maxW && text.length > 3) text = text.slice(0, -2);
  return text;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// геохэш: одна ячейка ~ 1.2×0.6 км при точности 6 — «район»
function geohash(lat, lon, precision) {
  const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  let idx = 0, bit = 0, even = true, hash = '';
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) { idx = idx * 2 + 1; lonMin = mid; } else { idx *= 2; lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { idx = idx * 2 + 1; latMin = mid; } else { idx *= 2; latMax = mid; }
    }
    even = !even;
    if (++bit === 5) { hash += BASE32[idx]; bit = 0; idx = 0; }
  }
  return hash;
}
