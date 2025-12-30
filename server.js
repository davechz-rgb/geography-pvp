const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
// Serve the frontend (public/index.html)
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });

const PORT = process.env.PORT || 3000;
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, "data.json"), "utf8"));

/* ---------- helpers ---------- */
function codeToFlag(code){
  if(!code || code.length !== 2) return "🏳️";
  const A = 0x1F1E6;
  return String.fromCodePoint(A + (code.charCodeAt(0)-65), A + (code.charCodeAt(1)-65));
}
function pick(arr, rng){
  return arr[Math.floor(rng()*arr.length)];
}
function mulberry32(seed){
  let t = seed >>> 0;
  return function(){
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(str){
  let h = 2166136261;
  for (let i=0;i<str.length;i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function shuffle(a, rng){
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(rng()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}
function uniqueSample(arr, n, rng){
  const copy = arr.slice();
  shuffle(copy, rng);
  return copy.slice(0, n);
}
function makeOptions(correct, pool, n, rng){
  const opts = [correct];
  const used = new Set([correct]);
  while(opts.length < n){
    const v = pick(pool, rng);
    if(!used.has(v)){
      used.add(v);
      opts.push(v);
    }
  }
  return shuffle(opts, rng);
}

/* ---------- question generation ---------- */
const TOPICS = ["capital","language","demonym","government","economy","flag"]; // flag => "Which country is this flag?"

function buildQuestion(country, topic, rng){
  const correctCountry = country;
  if(topic === "flag"){
    const prompt = "Which country does this flag belong to?";
    const correct = correctCountry.name;
    const pool = DATA.map(c=>c.name);
    const options = makeOptions(correct, pool, 4, rng);
    return {
      topic,
      prompt,
      flag: codeToFlag(correctCountry.code),
      options,
      answer: correct
    };
  }

  if(topic === "capital"){
    const prompt = `What is the capital of ${correctCountry.name}?`;
    const correct = correctCountry.capital;
    const pool = DATA.map(c=>c.capital);
    const options = makeOptions(correct, pool, 4, rng);
    return { topic, prompt, options, answer: correct };
  }
  if(topic === "language"){
    const prompt = `What language is spoken in ${correctCountry.name}?`;
    const correct = correctCountry.language;
    const pool = DATA.map(c=>c.language);
    const options = makeOptions(correct, pool, 4, rng);
    return { topic, prompt, options, answer: correct };
  }
  if(topic === "demonym"){
    const prompt = `A person from ${correctCountry.name} is...`;
    const correct = correctCountry.demonym;
    const pool = DATA.map(c=>c.demonym);
    const options = makeOptions(correct, pool, 4, rng);
    return { topic, prompt, options, answer: correct };
  }
  if(topic === "government"){
    const prompt = `What type of government does ${correctCountry.name} have?`;
    const correct = correctCountry.government;
    const pool = DATA.map(c=>c.government);
    const options = makeOptions(correct, pool, 4, rng);
    return { topic, prompt, options, answer: correct };
  }
  // economy
  const prompt = `A key part of ${correctCountry.name}'s economy is...`;
  const correct = correctCountry.economy;
  const pool = DATA.map(c=>c.economy);
  const options = makeOptions(correct, pool, 4, rng);
  return { topic:"economy", prompt, options, answer: correct };
}

function buildPack({seed, numQuestions=20, allowFlags=true}){
  const rng = mulberry32(seed);
  const topics = allowFlags ? TOPICS.slice() : TOPICS.filter(t=>t!=="flag");
  const pack = [];
  // choose countries without repetition as much as possible
  const chosenCountries = uniqueSample(DATA, Math.min(numQuestions, DATA.length), rng);
  for(let i=0;i<numQuestions;i++){
    const c = chosenCountries[i % chosenCountries.length];
    const t = topics[Math.floor(rng()*topics.length)];
    pack.push(buildQuestion(c, t, rng));
  }
  return pack;
}

/* ---------- rooms ---------- */
const rooms = new Map();
/*
rooms[roomId] = {
  roomId,
  seed,
  pack,
  status: "lobby" | "playing" | "finished",
  createdAt,
  players: {
    socketId: { name, correct, answers: [{q, choice, correct, ms}], finishedAtMs|null }
  },
  startAtMs
}
*/
function makeRoomCode(){
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for(let i=0;i<6;i++) out += chars[Math.floor(Math.random()*chars.length)];
  return out;
}

/* ---------- static ---------- */
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_,res)=>res.json({ok:true}));

io.on("connection", (socket)=>{
  socket.on("create_room", ({name, numQuestions, allowFlags})=>{
    const roomId = makeRoomCode();
    const seed = hashSeed(roomId + ":" + Date.now());
    const pack = buildPack({seed, numQuestions, allowFlags});
    rooms.set(roomId, {
      roomId,
      seed,
      pack,
      status:"lobby",
      createdAt: Date.now(),
      startAtMs: null,
      players: {
        [socket.id]: { name: (name||"Player 1").slice(0,18), correct:0, answers:[], finishedAtMs:null }
      }
    });
    socket.join(roomId);
    socket.emit("room_created", {roomId});
    io.to(roomId).emit("room_state", publicState(roomId));
  });

  socket.on("join_room", ({roomId, name})=>{
    roomId = (roomId||"").toUpperCase().trim();
    const room = rooms.get(roomId);
    if(!room) return socket.emit("error_msg", {message:"Room not found."});
    if(room.status !== "lobby") return socket.emit("error_msg", {message:"Game already started."});
    const playerCount = Object.keys(room.players).length;
    if(playerCount >= 2) return socket.emit("error_msg", {message:"Room is full."});
    room.players[socket.id] = { name:(name||"Player 2").slice(0,18), correct:0, answers:[], finishedAtMs:null };
    socket.join(roomId);
    io.to(roomId).emit("room_state", publicState(roomId));
  });

  socket.on("start_game", ({roomId})=>{
    const room = rooms.get(roomId);
    if(!room) return;
    if(room.status !== "lobby") return;
    if(Object.keys(room.players).length < 2) return;
    room.status = "playing";
    room.startAtMs = Date.now();
    // reset stats
    for(const pid of Object.keys(room.players)){
      room.players[pid].correct = 0;
      room.players[pid].answers = [];
      room.players[pid].finishedAtMs = null;
    }
    io.to(roomId).emit("game_started", { pack: room.pack, startAtMs: room.startAtMs });
    io.to(roomId).emit("room_state", publicState(roomId));
  });

  socket.on("answer", ({roomId, qIndex, choice})=>{
    const room = rooms.get(roomId);
    if(!room || room.status !== "playing") return;
    const player = room.players[socket.id];
    if(!player) return;
    if(typeof qIndex !== "number" || qIndex < 0 || qIndex >= room.pack.length) return;

    // prevent double-answering same question
    if(player.answers.some(a=>a.q === qIndex)) return;

    const q = room.pack[qIndex];
    const isCorrect = (choice === q.answer);

    const ms = Date.now() - room.startAtMs;
    player.answers.push({ q:qIndex, choice, correct:isCorrect, ms });
    if(isCorrect) player.correct += 1;

    io.to(roomId).emit("answer_update", {
      playerId: socket.id,
      qIndex,
      choice,
      correct: isCorrect,
      correctAnswer: q.answer
    });

    // if player finished
    if(player.answers.length === room.pack.length){
      player.finishedAtMs = ms;
      io.to(roomId).emit("room_state", publicState(roomId));
      maybeFinish(roomId);
    }
  });

  socket.on("leave_room", ({roomId})=>{
    socket.leave(roomId);
    const room = rooms.get(roomId);
    if(room && room.players[socket.id]){
      delete room.players[socket.id];
      if(Object.keys(room.players).length === 0) rooms.delete(roomId);
      else io.to(roomId).emit("room_state", publicState(roomId));
    }
  });

  socket.on("disconnect", ()=>{
    // remove from any room
    for(const [roomId, room] of rooms.entries()){
      if(room.players[socket.id]){
        delete room.players[socket.id];
        if(Object.keys(room.players).length === 0) rooms.delete(roomId);
        else io.to(roomId).emit("room_state", publicState(roomId));
      }
    }
  });
});

function publicState(roomId){
  const room = rooms.get(roomId);
  if(!room) return null;
  const players = Object.entries(room.players).map(([id,p])=>({
    id,
    name: p.name,
    correct: p.correct,
    answered: p.answers.length,
    finishedAtMs: p.finishedAtMs
  }));
  return { roomId, status: room.status, players, total: room.pack.length, startAtMs: room.startAtMs };
}

function maybeFinish(roomId){
  const room = rooms.get(roomId);
  if(!room || room.status !== "playing") return;
  const players = Object.entries(room.players);
  if(players.length < 2) return;

  const allFinished = players.every(([_,p]) => p.finishedAtMs !== null);
  if(!allFinished) return;

  room.status = "finished";

  // winner: highest correct, tie => lower finishedAtMs
  const results = players.map(([id,p])=>({id, name:p.name, correct:p.correct, timeMs:p.finishedAtMs}));
  results.sort((a,b)=>{
    if(b.correct !== a.correct) return b.correct - a.correct;
    return a.timeMs - b.timeMs;
  });
  const winner = results[0];
  io.to(roomId).emit("game_finished", { results, winnerId: winner.id });
  io.to(roomId).emit("room_state", publicState(roomId));
}

server.listen(PORT, ()=>{
  console.log("Server running on port", PORT);
});
