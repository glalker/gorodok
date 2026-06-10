// Тестовый бот: заходит в городок, подходит к первому игроку и болтает.
// Запуск: node bot.js <имя> <статус> <сообщение1> <сообщение2> ...
const WebSocket = require('ws');

const [, , name, status, ...messages] = process.argv;
const ws = new WebSocket('ws://localhost:3000');
let me = null;
let target = null;

ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'join', room: 'Городок', name, status }));
});

ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (m.t === 'welcome') {
    me = { id: m.id };
    const other = m.players.find(p => p.id !== m.id);
    target = other ? { x: other.x, y: other.y } : { x: m.world.w / 2, y: m.world.h / 2 };
    // встать рядом с целью (в радиусе группы)
    const x = target.x + (Math.random() * 120 - 60);
    const y = target.y + (Math.random() * 120 - 60);
    ws.send(JSON.stringify({ t: 'move', x, y }));
    // болтать
    messages.forEach((text, i) => {
      setTimeout(() => ws.send(JSON.stringify({ t: 'chat', text })), 800 + i * 1500);
    });
  }
});

setTimeout(() => process.exit(0), 120_000);
