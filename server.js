const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const DB = require('./db');
const Engine = require('./engine');

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

// --- 重连与连接 ---
io.on('connection', (socket) => {
    socket.emit('room_stats', { playerCount: gameState.players.length, isGaming: gameState.round !== 'waiting', ledger: gameState.ledger });
    socket.on('join_req', (name) => {
        const player = gameState.players.find(p => p.name === name);
        if (player) { player.id = socket.id; player.connected = true; socket.emit('login_success', { name: name, isPlayer: true }); return broadcastState(); }
        let spec = gameState.spectators.find(s => s.name === name);
        if (spec) spec.id = socket.id; else gameState.spectators.push({ id: socket.id, name: name });
        socket.emit('login_success', { name: name, isPlayer: false }); broadcastState();
    });
    socket.on('sit_down', (name) => {
        if (gameState.players.find(p => p.name === name)) return;
        if (gameState.players.length >= 6) return;
        const chips = DB.getUserChips(name);
        gameState.players.push({ id: socket.id, name: name, chips: chips, seat: gameState.players.length, status: 'idle', currentBet: 0, totalHandInvestment: 0, lastAction: "", needsToAct: false, connected: true });
        gameState.spectators = gameState.spectators.filter(s => s.id !== socket.id);
        broadcastState();
        if (gameState.players.length >= 2 && gameState.round === 'waiting') startGame();
    });
    socket.on('player_action', (d) => handleAction(socket.id, d));
    socket.on('start_hand', () => { if (gameState.players.length >= 2 && gameState.round === 'waiting') startGame(); });
    socket.on('disconnect', () => {
        const p = gameState.players.find(p => p.id === socket.id);
        if (p) { p.connected = false; if (gameState.round === 'waiting') gameState.players = gameState.players.filter(pl => pl.id !== socket.id); }
        gameState.spectators = gameState.spectators.filter(s => s.id !== socket.id);
        broadcastState();
    });
});

// --- 游戏主控状态机 (终极修正) ---

function startGame() {
    console.log(">>> 状态机：New Hand Started");
    gameState.round = 'pre-flop';
    gameState.deck = createDeck();
    gameState.communityCards = [];
    gameState.minRaise = CONFIG.BIG_BLIND;
    
    gameState.players.forEach(p => {
        if (p.connected) {
            p.hand = [gameState.deck.pop(), gameState.deck.pop()];
            p.status = 'active'; p.currentBet = 0; p.totalHandInvestment = 0; p.lastAction = ""; p.needsToAct = true;
        } else { p.status = 'idle'; }
    });

    const len = gameState.players.length;
    let sbIdx, bbIdx;

    if (len === 2) {
        // 二人对局特殊规则：Dealer 是小盲
        sbIdx = gameState.dealerIdx;
        bbIdx = (gameState.dealerIdx + 1) % 2;
        gameState.activeSeat = sbIdx; // 翻牌前小盲先动
    } else {
        sbIdx = (gameState.dealerIdx + 1) % len;
        bbIdx = (gameState.dealerIdx + 2) % len;
        gameState.activeSeat = (gameState.dealerIdx + 3) % len; // 大盲后一位先动
    }

    investChips(gameState.players[sbIdx], CONFIG.SMALL_BLIND, "小盲");
    investChips(gameState.players[bbIdx], CONFIG.BIG_BLIND, "大盲");
    
    // 【关键修复】大盲位在翻牌前必须有权再次动作
    gameState.players[bbIdx].needsToAct = true;

    gameState.currentBet = CONFIG.BIG_BLIND;
    // 确保 activeSeat 指向一个能动的人
    while (gameState.players[gameState.activeSeat].status !== 'active') {
        gameState.activeSeat = (gameState.activeSeat + 1) % len;
    }

    gameState.pots = Engine.calculatePots(gameState.players);
    startTimer(); io.emit('deal_cards'); broadcastState();
}

function handleAction(pid, act) {
    const p = gameState.players.find(pl => pl.id === pid);
    if (!p || p.seat !== gameState.activeSeat || p.status !== 'active') return;
    clearTimeout(gameState.timer);

    if (act.type === 'fold') {
        p.status = 'folded'; p.lastAction = "FOLD"; p.needsToAct = false;
    } else if (act.type === 'call') {
        const diff = gameState.currentBet - p.currentBet;
        p.lastAction = diff === 0 ? "CHECK" : `CALL ${diff}`;
        investChips(p, diff);
        p.needsToAct = false;
    } else if (act.type === 'raise') {
        const raiseTo = parseInt(act.amount);
        const raiseBy = raiseTo - gameState.currentBet;
        investChips(p, raiseTo - p.currentBet);
        p.lastAction = `RAISE ${raiseTo}`;
        gameState.currentBet = raiseTo;
        gameState.minRaise = Math.max(CONFIG.BIG_BLIND, raiseBy);
        // 加注重置所有“非弃牌且非全押”的玩家
        gameState.players.forEach(pl => { if(pl.id !== p.id && pl.status === 'active') pl.needsToAct = true; });
        p.needsToAct = false;
    }

    gameState.pots = Engine.calculatePots(gameState.players);
    finalizeAction();
}

function finalizeAction() {
    const remaining = gameState.players.filter(pl => pl.status === 'active' || pl.status === 'all-in');
    if (remaining.length === 1) return settleWinners(remaining);

    const activeMover = gameState.players.filter(pl => pl.status === 'active');
    if (activeMover.length <= 1) return autoFinish();

    // 判断本轮结束条件：
    // 1. 所有活跃玩家（非全押非弃牌）注码持平
    // 2. 且所有活跃玩家 needsToAct 为 false
    const roundOver = gameState.players.filter(pl => pl.status === 'active').every(pl => {
        return pl.currentBet === gameState.currentBet && !pl.needsToAct;
    });

    if (roundOver) advanceRound();
    else moveToNext();
}

function advanceRound() {
    console.log(`>>> 状态机：Round ${gameState.round} Ended`);
    if (gameState.round === 'river') return showdown();

    gameState.players.forEach(p => { 
        p.currentBet = 0; p.lastAction = ""; 
        if(p.status === 'active') p.needsToAct = true; 
    });
    gameState.currentBet = 0;
    gameState.minRaise = CONFIG.BIG_BLIND;

    if (gameState.round === 'pre-flop') { gameState.round = 'flop'; for(let i=0;i<3;i++) gameState.communityCards.push(gameState.deck.pop()); }
    else if (gameState.round === 'flop') { gameState.round = 'turn'; gameState.communityCards.push(gameState.deck.pop()); }
    else if (gameState.round === 'turn') { gameState.round = 'river'; gameState.communityCards.push(gameState.deck.pop()); }

    // 回合开始：庄家后第一个活跃玩家。如果是 2 人对局，庄家后第一个就是 non-dealer
    moveToNext((gameState.dealerIdx + 1) % gameState.players.length);
}

function moveToNext(start) {
    if (start !== undefined) gameState.activeSeat = start;
    else gameState.activeSeat = (gameState.activeSeat + 1) % gameState.players.length;

    let attempts = 0;
    while (gameState.players[gameState.activeSeat].status !== 'active' && attempts < 10) {
        gameState.activeSeat = (gameState.activeSeat + 1) % gameState.players.length;
        attempts++;
    }
    broadcastState(); startTimer();
}

// ... 其余辅助、结算逻辑保持 Engine 模块的稳定性 ...

function showdown() {
    gameState.round = 'showdown'; broadcastState();
    const results = Engine.determineWinners(gameState.pots, gameState.players, gameState.communityCards);
    results.forEach(r => { const pl = gameState.players.find(p => p.id === r.id); pl.chips += r.amount; DB.updateUserChips(pl.name, pl.chips); });
    DB.addLedgerEntry(results.map(r=>r.name).join(','), results.reduce((s,r)=>s+r.amount,0), results[0]?.handName || "比牌");
    gameState.ledger = DB.getRecentLedger();
    io.emit('game_result', { details: results, ledger: gameState.ledger });
    setTimeout(() => { gameState.dealerIdx = (gameState.dealerIdx + 1) % gameState.players.length; if (gameState.players.length >= 2) startGame(); else resetGame(); }, 5000);
}

function settleWinners(w) { const tot = gameState.pots.reduce((s,p)=>s+p.amount,0); w.forEach(p => { p.chips += Math.floor(tot/w.length); DB.updateUserChips(p.name, p.chips); }); DB.addLedgerEntry(w.map(p=>p.name).join(','), tot, "对手弃牌获胜"); gameState.ledger = DB.getRecentLedger(); io.emit('game_result', { details: w.map(p=>({name:p.name, amount: tot, handName:"弃牌获胜"})), ledger: gameState.ledger }); setTimeout(() => { gameState.dealerIdx = (gameState.dealerIdx + 1) % gameState.players.length; startGame(); }, 3000); }
function investChips(p, a, l) { const act = Math.min(p.chips, a); p.chips -= act; p.currentBet += act; p.totalHandInvestment += act; if(l) p.lastAction = l; if(p.chips === 0 && act > 0) { p.status='all-in'; p.lastAction='ALL-IN'; p.needsToAct=false; } DB.updateUserChips(p.name, p.chips); }
function autoFinish() { while(gameState.communityCards.length < 5) gameState.communityCards.push(gameState.deck.pop()); showdown(); }
function createDeck() { const s=['♥','♠','♦','♣'], v=['2','3','4','5','6','7','8','9','10','J','Q','K','A']; let d=[]; for(let su of s)for(let va of v) d.push({value:va, suit:su, color:(su==='♥'||su==='♦')?'red':'black'}); return d.sort(()=>Math.random()-0.5); }
function broadcastState() { gameState.players.forEach(p => io.to(p.id).emit('update_state', sanitizeState(gameState, p.id))); gameState.spectators.forEach(s => io.to(s.id).emit('update_state', sanitizeState(gameState, null))); }
function sanitizeState(s, vid) { return { ...s, players: s.players.map(p => ({ ...p, hand: (p.id === vid || s.round === 'showdown') ? p.hand : ['?', '?'] })), timer: null }; }
function resetGame() { gameState.round = 'waiting'; gameState.pots = []; gameState.communityCards = []; broadcastState(); }
function startTimer() { if (gameState.timer) clearTimeout(gameState.timer); gameState.timer = setTimeout(() => { const p = gameState.players[gameState.activeSeat]; if (p) handleAction(p.id, { type: 'fold' }); }, CONFIG.TURN_TIME); }

server.listen(3000, '0.0.0.0', () => console.log(`ACE PRO v8 - Logic Perfected`));
