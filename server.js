const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const WORLD = { w: 2200, h: 1400 };
const METER = 32;             // пикселей в одном «метре»
const MIN_RADIUS_M = 1;
const MAX_RADIUS_M = 10;
const DEFAULT_RADIUS_M = 8;   // насколько далеко тебя слышно
const CLUSTER_RADIUS = 160;   // в пределах этого радиуса люди считаются одной группой
const TOPIC_INTERVAL = 7000;  // как часто пересчитываем группы и темы
const CHAT_TTL = 90_000;      // сколько сообщения учитываются в теме беседы
const DEFAULT_ROOM = 'Городок';

// --- Anthropic: краткая тема беседы для группы (опционально) ---
let anthropic = null;
if (process.env.ANTHROPIC_API_KEY) {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic();
    console.log('AI-темы бесед: включены (' + aiModel() + ')');
  } catch (e) {
    console.log('AI-темы бесед: SDK недоступен, фоллбэк на ключевые слова');
  }
} else {
  console.log('AI-темы бесед: нет ANTHROPIC_API_KEY, фоллбэк на ключевые слова');
}

function aiModel() {
  return process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
}

const STOPWORDS = new Set(('и в во не что он на я с со как а то все она так его но да ты к у же вы ' +
  'за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже ' +
  'или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где ' +
  'есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто ' +
  'этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда ' +
  'зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про ' +
  'всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя ' +
  'такой им более всегда конечно всю между это привет пока ага угу окей ок да-да ну-ну типа короче ' +
  'the a an is are was were be been i you he she it we they to of in on at for with and or but not')
  .split(/\s+/));

function keywordTopic(msgs) {
  const counts = new Map();
  for (const m of msgs) {
    for (const raw of m.text.toLowerCase().split(/[^a-zа-яё0-9-]+/i)) {
      const w = raw.trim();
      if (w.length < 3 || STOPWORDS.has(w)) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
  return top.length ? top.join(', ') : 'болтают о своём';
}

const topicCache = new Map(); // key -> topic
async function topicFor(msgs) {
  const key = msgs.map(m => m.text).join('');
  if (topicCache.has(key)) return topicCache.get(key);
  let topic;
  if (anthropic) {
    try {
      const resp = await anthropic.messages.create({
        model: aiModel(),
        max_tokens: 50,
        system: 'Ты определяешь тему беседы по сообщениям чата. Отвечай только темой: 2–5 слов на русском, без кавычек и точки. Если тема неясна — ответь: болтают о своём.',
        messages: [{ role: 'user', content: msgs.map(m => '- ' + m.text).join('\n') }],
      });
      topic = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim() || keywordTopic(msgs);
    } catch (e) {
      console.error('AI topic error:', e.message);
      topic = keywordTopic(msgs);
    }
  } else {
    topic = keywordTopic(msgs);
  }
  if (topicCache.size > 200) topicCache.clear();
  topicCache.set(key, topic);
  return topic;
}

// --- HTTP + WS ---
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/rooms', (req, res) => {
  const list = [...rooms.entries()].map(([name, r]) => ({ name, count: r.players.size }));
  if (!rooms.has(DEFAULT_ROOM)) list.unshift({ name: DEFAULT_ROOM, count: 0 });
  res.json(list);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map();
let nextId = 1;

function getRoom(name) {
  if (!rooms.has(name)) rooms.set(name, { players: new Map(), chats: [] });
  return rooms.get(name);
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const pub = p => ({ id: p.id, name: p.name, status: p.status, x: p.x, y: p.y, hue: p.hue, voice: p.voice, radius: p.radius });
const radiusPx = m => clamp(Math.round(+m) || DEFAULT_RADIUS_M, MIN_RADIUS_M, MAX_RADIUS_M) * METER;

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(room, msg, exceptId) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(data);
  }
}

wss.on('connection', ws => {
  let room = null;
  let me = null;

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'join' && !me) {
      const roomName = String(m.room || DEFAULT_ROOM).slice(0, 48) || DEFAULT_ROOM;
      room = getRoom(roomName);
      me = {
        id: nextId++,
        name: String(m.name || '').trim().slice(0, 24) || 'Стикмен-' + (100 + Math.floor(Math.random() * 900)),
        status: String(m.status || '').trim().slice(0, 90),
        x: WORLD.w / 2 + (Math.random() * 320 - 160),
        y: WORLD.h / 2 + (Math.random() * 320 - 160),
        hue: Math.floor(Math.random() * 360),
        voice: false,
        radius: radiusPx(m.radius),
        ws,
      };
      room.players.set(me.id, me);
      send(ws, {
        t: 'welcome', id: me.id, room: roomName, world: WORLD, meter: METER,
        players: [...room.players.values()].map(pub),
      });
      broadcast(room, { t: 'player_join', p: pub(me) }, me.id);
      return;
    }
    if (!me || !room) return;

    switch (m.t) {
      case 'move':
        me.x = clamp(+m.x || 0, 0, WORLD.w);
        me.y = clamp(+m.y || 0, 0, WORLD.h);
        broadcast(room, { t: 'move', id: me.id, x: me.x, y: me.y }, me.id);
        break;
      case 'chat': {
        const text = String(m.text || '').trim().slice(0, 200);
        if (!text) break;
        room.chats.push({ id: me.id, text, at: Date.now() });
        // слышат только те, кто в радиусе говорящего — суть проксимити-чата
        for (const p of room.players.values()) {
          if (dist(p, me) <= me.radius * 1.4) send(p.ws, { t: 'chat', id: me.id, text });
        }
        break;
      }
      case 'radius':
        me.radius = radiusPx(m.v);
        broadcast(room, { t: 'radius', id: me.id, v: me.radius });
        break;
      case 'status':
        me.status = String(m.text || '').trim().slice(0, 90);
        broadcast(room, { t: 'status', id: me.id, text: me.status });
        break;
      case 'voice':
        me.voice = !!m.on;
        broadcast(room, { t: 'voice', id: me.id, on: me.voice }, me.id);
        break;
      case 'rtc': {
        const target = room.players.get(+m.to);
        if (target) send(target.ws, { t: 'rtc', from: me.id, data: m.data });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (room && me) {
      room.players.delete(me.id);
      broadcast(room, { t: 'player_leave', id: me.id });
    }
  });
});

// --- группы и темы бесед ---
function findClusters(players, radius) {
  const parent = new Map(players.map(p => [p.id, p.id]));
  const find = id => {
    while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); }
    return id;
  };
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      if (dist(players[i], players[j]) <= radius) {
        parent.set(find(players[i].id), find(players[j].id));
      }
    }
  }
  const groups = new Map();
  for (const p of players) {
    const root = find(p.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(p);
  }
  return [...groups.values()];
}

setInterval(() => {
  const now = Date.now();
  for (const [name, room] of rooms) {
    room.chats = room.chats.filter(c => now - c.at < CHAT_TTL);
    if (room.players.size === 0) { rooms.delete(name); continue; }

    const players = [...room.players.values()];
    const clusters = findClusters(players, CLUSTER_RADIUS).filter(c => c.length >= 2);

    Promise.all(clusters.map(async c => {
      const ids = new Set(c.map(p => p.id));
      const msgs = room.chats.filter(ch => ids.has(ch.id)).slice(-12);
      const topic = msgs.length >= 2 ? await topicFor(msgs) : null;
      return {
        ids: [...ids],
        topic,
        x: c.reduce((s, p) => s + p.x, 0) / c.length,
        y: Math.min(...c.map(p => p.y)),
      };
    })).then(list => {
      broadcast(room, { t: 'clusters', clusters: list });
    }).catch(() => {});
  }
}, TOPIC_INTERVAL);

server.listen(PORT, () => {
  console.log(`Городок запущен: http://localhost:${PORT}`);
});
