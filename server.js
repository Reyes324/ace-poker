const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const DB = require('./db');
const Engine = require('./engine');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const CONFIG = { SMALL_BLIND: 10, BIG_BLIND: 20, TURN_TIME: 20000 };

let gameState = {
    players: [], 
    spectators: [], 
    pots: [], 
    communityCards: [],
    deck: [],
    round: 'waiting', 
    activeSeat: -1,
    currentBet: 0,
    minRaise: CONFIG.BIG_BLIND, 
    dealerIdx: 0,
    ledger: DB.getRecentLedger()
};

io.on('connection', (socket) => {
    socket.emit('room_stats', { playerCount: gameState.players.length, isGaming: gameState.round !== 'waiting', ledger: gameState.ledger });
    
    socket.on('join_req', (name) => {
        const player = gameState.players.find(p => p.name === name);
        if (player) {
            player.id = socket.id;
            player.connected = true;
            socket.emit('login_success', { name: name, isPlayer: true });
            return broadcastState();
        }
        let spec = gameState.spectators.find(s => s.name === name);
        if (spec) spec.id = socket.id; else gameState.spectators.push({ id: socket.id, name: name });
        socket.emit('login_success', { name: name, isPlayer: false }); broadcastState();
    });

    socket.on('sit_down', (name) => {
        if (gameState.players.find(p => p.name === name)) return;
        const specIdx = gameState.spectators.findIndex(s => s.id === socket.id);
        const chips = DB.getUserChips(name);
        gameState.players.push({ id: socket.id, name: name, chips: chips, seat: gameState.players.length, status: 'idle', currentBet: 0, totalHandInvestment: 0, lastAction: "", needsToAct: false, connected: true });
        if (specIdx !== -1) gameState.spectators.splice(specIdx, 1);
        
        // 【关键改动】此处不再自动 startGame()，由房主手动触发
        broadcastState();
    });

    socket.on('player_action', (d) => handleAction(socket.id, d));
    
    // 手动开始事件
    socket.on('start_hand', () => {
        const p = gameState.players.find(pl => pl.id === socket.id);
        if (!p) return;
        const pIdx = gameState.players.indexOf(p);
        // 只有当前庄家（房主）有权点击开始
        if (pIdx === gameState.dealerIdx && gameState.players.length >= 2 && gameState.round === 'waiting') {
            startGame();
        }
    });
    
    socket.on('disconnect', () => {
        const p = gameState.players.find(p => p.id === socket.id);
        if (p) p.connected = false;
        gameState.spectators = gameState.spectators.filter(s => s.id !== socket.id);
        broadcastState();
    });
});

// --- 状态机控制 (优化循环开启) ---

function startGame() {
    if (gameState.timer) clearTimeout(gameState.timer);
    if (gameState.players.length < 2) {
        gameState.round = 'waiting';
        return broadcastState();
    }

    console.log("--- 牌局正式由房主启动 ---");
    gameState.round = 'pre-flop';
    gameState.deck = createDeck();
    gameState.communityCards = [];
    gameState.pots = [];
    gameState.currentBet = CONFIG.BIG_BLIND;
    gameState.minRaise = CONFIG.BIG_BLIND;

    gameState.players.forEach(p => {
        p.hand = [gameState.deck.pop(), gameState.deck.pop()];
        p.currentBet = 0; p.totalHandInvestment = 0; p.lastAction = "";
        if (p.connected && p.chips > 0) { p.status = 'active'; p.needsToAct = true; }
        else { p.status = 'idle'; p.needsToAct = false; }
    });

    const len = gameState.players.length;
    let sbIdx, bbIdx;
    if (len === 2) {
        sbIdx = gameState.dealerIdx;
        bbIdx = (gameState.dealerIdx + 1) % 2;
        gameState.activeSeat = sbIdx;
    } else {
        sbIdx = (gameState.dealerIdx + 1) % len;
        bbIdx = (gameState.dealerIdx + 2) % len;
        gameState.activeSeat = (gameState.dealerIdx + 3) % len;
    }

    investChips(gameState.players[sbIdx], CONFIG.SMALL_BLIND, "小盲");
    investChips(gameState.players[bbIdx], CONFIG.BIG_BLIND, "大盲");
    gameState.players[bbIdx].needsToAct = true;

    while (gameState.players[gameState.activeSeat].status !== 'active') {
        gameState.activeSeat = (gameState.activeSeat + 1) % len;
    }

    gameState.pots = Engine.calculatePots(gameState.players);
    io.emit('deal_cards');
    broadcastState();
    startTimer();
}

function handleAction(pid, act) {
    const p = gameState.players.find(pl => pl.id === pid);
    if (!p || p.seat !== gameState.activeSeat || p.status !== 'active') return;
    clearTimeout(gameState.timer);
    if (act.type === 'fold') { p.status = 'folded'; p.lastAction = "FOLD"; p.needsToAct = false; }
    else if (act.type === 'call') {
        const diff = gameState.currentBet - p.currentBet;
        p.lastAction = diff === 0 ? "CHECK" : `CALL ${diff}`;
        investChips(p, diff); p.needsToAct = false;
    } else if (act.type === 'raise') {
        const raiseTo = parseInt(act.amount);
        investChips(p, raiseTo - p.currentBet);
        p.lastAction = `RAISE ${raiseTo}`;
        gameState.minRaise = Math.max(CONFIG.BIG_BLIND, raiseTo - gameState.currentBet);
        gameState.currentBet = raiseTo;
        gameState.players.forEach(pl => { if(pl.id !== p.id && pl.status === 'active') pl.needsToAct = true; });
        p.needsToAct = false;
    }
    gameState.pots = Engine.calculatePots(gameState.players);
    finalizeAction();
}

function finalizeAction() {
    const survivors = gameState.players.filter(pl => pl.status === 'active' || pl.status === 'all-in');
    if (survivors.length === 1) return settleWinnersByFold(survivors[0]);
    const activeMover = gameState.players.filter(pl => pl.status === 'active');
    if (activeMover.length <= 1) return autoFinish();
    const roundOver = gameState.players.filter(pl => pl.status === 'active').every(pl => {
        return pl.currentBet === gameState.currentBet && !pl.needsToAct;
    });
    if (roundOver) advanceRound(); else moveToNext();
}

function advanceRound() {
    if (gameState.round === 'river') return showdown();
    gameState.players.forEach(p => { p.currentBet = 0; p.lastAction = ""; if(p.status === 'active') p.needsToAct = true; });
    gameState.currentBet = 0;
    if (gameState.round === 'pre-flop') { gameState.round = 'flop'; for(let i=0;i<3;i++) gameState.communityCards.push(gameState.deck.pop()); }
    else if (gameState.round === 'flop') { gameState.round = 'turn'; gameState.communityCards.push(gameState.deck.pop()); }
    else if (gameState.round === 'turn') { gameState.round = 'river'; gameState.communityCards.push(gameState.deck.pop()); }
    moveToNext((gameState.dealerIdx + 1) % gameState.players.length);
}

function showdown() {
    gameState.round = 'showdown'; broadcastState();
    const results = Engine.determineWinners(gameState.pots, gameState.players, gameState.communityCards);
    results.forEach(r => { const pl = gameState.players.find(p => p.id === r.id); pl.chips += r.amount; DB.updateUserChips(pl.name, pl.chips); });
    DB.addLedgerEntry(results.map(r=>r.name).join(','), results.reduce((s,r)=>s+r.amount,0), results[0]?.handName || "比牌");
    gameState.ledger = DB.getRecentLedger();
    io.emit('game_result', { details: results, ledger: gameState.ledger });
    
    // 【关键改动】结算后回到 waiting 状态，由房主再次点开始
    setTimeout(() => {
        gameState.dealerIdx = (gameState.dealerIdx + 1) % gameState.players.length;
        gameState.round = 'waiting';
        broadcastState();
    }, 6000);
}

function settleWinnersByFold(winner) {
    const tot = gameState.pots.reduce((s,p)=>s+p.amount,0);
    winner.chips += tot; DB.updateUserChips(winner.name, winner.chips);
    DB.addLedgerEntry(winner.name, tot, "对手弃牌");
    gameState.ledger = DB.getRecentLedger();
    io.emit('game_result', { details: [{name: winner.name, amount: tot, handName:"对手弃牌"}], ledger: gameState.ledger });
    
    setTimeout(() => {
        gameState.dealerIdx = (gameState.dealerIdx + 1) % gameState.players.length;
        gameState.round = 'waiting';
        broadcastState();
    }, 4000);
}

// 辅助逻辑与 Crypto 洗牌...
function investChips(p, a, l) { const act = Math.min(p.chips, a); p.chips -= act; p.currentBet += act; p.totalHandInvestment += act; if(l) p.lastAction = l; if(p.chips === 0 && act > 0) { p.status='all-in'; p.lastAction='ALL-IN'; p.needsToAct=false; } DB.updateUserChips(p.name, p.chips); }
function moveToNext(s) { if(s !== undefined) gameState.activeSeat = s; else gameState.activeSeat = (gameState.activeSeat + 1) % gameState.players.length; let att = 0; while (gameState.players[gameState.activeSeat].status !== 'active' && att < 10) { gameState.activeSeat = (gameState.activeSeat + 1) % gameState.players.length; att++; } broadcastState(); startTimer(); }
function autoFinish() { while(gameState.communityCards.length < 5) gameState.communityCards.push(gameState.deck.pop()); showdown(); }
function createDeck() {
    const suits = ['♥', '♠', '♦', '♣'], values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let s of suits) for (let v of values) deck.push({ value: v, suit: s, color: (s === '♥' || s === '♦') ? 'red' : 'black' });
    for (let i = deck.length - 1; i > 0; i--) { const r = crypto.randomBytes(1)[0]; const j = Math.floor((r / 256) * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    return deck;
}
function broadcastState() { gameState.players.forEach(p => io.to(p.id).emit('update_state', sanitizeState(gameState, p.id))); gameState.spectators.forEach(s => io.to(s.id).emit('update_state', sanitizeState(gameState, null))); }
function sanitizeState(s, vid) { return { ...s, players: s.players.map(p => ({ ...p, hand: (p.id === vid || s.round === 'showdown') ? p.hand : ['?', '?'] })), timer: null }; }
function startTimer() { if (gameState.timer) clearTimeout(gameState.timer); gameState.timer = setTimeout(() => { const p = gameState.players[gameState.activeSeat]; if (p) handleAction(p.id, { type: 'fold' }); }, CONFIG.TURN_TIME); }

server.listen(PORT, '0.0.0.0', () => console.log(`ACE PRO v11 - Manual Start Only`));
