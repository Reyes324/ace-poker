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
    socket.emit('room_stats', {
        playerCount: gameState.players.length,
        isGaming: gameState.round !== 'waiting',
        ledger: gameState.ledger
    });

    socket.on('join_req', (name) => {
        const player = gameState.players.find(p => p.name === name);
        if (player) {
            player.id = socket.id;
            player.connected = true;
            socket.emit('login_success', { name: name, isPlayer: true });
            return broadcastState();
        }
        let spec = gameState.spectators.find(s => s.name === name);
        if (spec) {
            spec.id = socket.id;
        } else {
            gameState.spectators.push({ id: socket.id, name: name });
        }
        socket.emit('login_success', { name: name, isPlayer: false });
        broadcastState();
    });

    socket.on('sit_down', (name) => {
        if (gameState.players.find(p => p.name === name)) return;
        // 1.10: 最大玩家数限制
        if (gameState.players.length >= 9) return;
        const specIdx = gameState.spectators.findIndex(s => s.id === socket.id);
        const chips = DB.getUserChips(name);
        gameState.players.push({
            id: socket.id,
            name: name,
            chips: chips,
            seat: gameState.players.length,
            status: 'idle',
            currentBet: 0,
            totalHandInvestment: 0,
            lastAction: "",
            needsToAct: false,
            connected: true
        });
        if (specIdx !== -1) gameState.spectators.splice(specIdx, 1);
        broadcastState();
    });

    socket.on('player_action', (d) => handleAction(socket.id, d));

    // 手动开始事件
    socket.on('start_hand', () => {
        const p = gameState.players.find(pl => pl.id === socket.id);
        if (!p) return;
        const pIdx = gameState.players.indexOf(p);
        if (pIdx === gameState.dealerIdx && gameState.players.length >= 2 && gameState.round === 'waiting') {
            startGame();
        }
    });

    // 1.9: 重新买入机制
    socket.on('rebuy', () => {
        const p = gameState.players.find(pl => pl.id === socket.id);
        if (!p) return;
        if (p.chips > 0) return; // 还有筹码，不允许rebuy
        if (gameState.round !== 'waiting') return; // 只在等待阶段允许
        p.chips = 1000;
        DB.updateUserChips(p.name, p.chips);
        broadcastState();
    });

    // 1.11: 断线重连时处理
    socket.on('disconnect', () => {
        const p = gameState.players.find(p => p.id === socket.id);
        if (p) {
            p.connected = false;
            // 如果断线的是当前行动玩家，立即 auto-fold
            if (gameState.round !== 'waiting' &&
                gameState.round !== 'showdown' &&
                p.seat === gameState.activeSeat &&
                p.status === 'active') {
                clearTimeout(gameState.timer);
                handleAction(p.id, { type: 'fold' });
                return; // handleAction already broadcasts
            }
        }
        gameState.spectators = gameState.spectators.filter(s => s.id !== socket.id);
        broadcastState();
    });
});

// --- 状态机控制 ---

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
        p.currentBet = 0;
        p.totalHandInvestment = 0;
        p.lastAction = "";
        if (p.connected && p.chips > 0) {
            p.status = 'active';
            p.needsToAct = true;
        } else {
            p.status = 'idle';
            p.needsToAct = false;
        }
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

    // 1.3: 只在 BB 仍然是 active 时设置 needsToAct
    // (investChips 可能已将其设为 all-in)
    // line 99 已经对所有 active 设了 needsToAct=true，此处不再重复覆盖

    // 找到第一个 active 的玩家作为起始行动位
    let startSeat = gameState.activeSeat;
    let attempts = 0;
    while (gameState.players[startSeat].status !== 'active' && attempts < len) {
        startSeat = (startSeat + 1) % len;
        attempts++;
    }
    gameState.activeSeat = startSeat;

    gameState.pots = Engine.calculatePots(gameState.players);
    io.emit('deal_cards');
    broadcastState();
    startTimer();
}

function handleAction(pid, act) {
    const p = gameState.players.find(pl => pl.id === pid);
    if (!p || p.seat !== gameState.activeSeat || p.status !== 'active') return;
    clearTimeout(gameState.timer);

    if (act.type === 'fold') {
        p.status = 'folded';
        p.lastAction = "FOLD";
        p.needsToAct = false;
    } else if (act.type === 'call') {
        const diff = gameState.currentBet - p.currentBet;
        p.lastAction = diff === 0 ? "CHECK" : `CALL ${diff}`;
        investChips(p, diff);
        p.needsToAct = false;
    } else if (act.type === 'raise') {
        let raiseTo = parseInt(act.amount);

        // 1.5: 加注验证
        const minRaiseTo = gameState.currentBet + gameState.minRaise;
        const maxRaiseTo = p.chips + p.currentBet;

        if (isNaN(raiseTo)) {
            // 无效金额，降级为 call
            const diff = gameState.currentBet - p.currentBet;
            p.lastAction = diff === 0 ? "CHECK" : `CALL ${diff}`;
            investChips(p, diff);
            p.needsToAct = false;
        } else {
            // 如果加注金额不够最小加注但足够 all-in，允许 all-in
            if (raiseTo < minRaiseTo) {
                if (maxRaiseTo <= minRaiseTo) {
                    // all-in 例外：筹码不够最小加注，全下
                    raiseTo = maxRaiseTo;
                } else {
                    // 有足够筹码但加注不够，调整到最小加注
                    raiseTo = minRaiseTo;
                }
            }
            // 不能超过自己的筹码
            if (raiseTo > maxRaiseTo) {
                raiseTo = maxRaiseTo;
            }

            const raiseIncrement = raiseTo - gameState.currentBet;
            investChips(p, raiseTo - p.currentBet);
            p.lastAction = `RAISE ${raiseTo}`;
            gameState.minRaise = Math.max(CONFIG.BIG_BLIND, raiseIncrement);
            gameState.currentBet = raiseTo;
            gameState.players.forEach(pl => {
                if (pl.id !== p.id && pl.status === 'active') {
                    pl.needsToAct = true;
                }
            });
            p.needsToAct = false;
        }
    }

    gameState.pots = Engine.calculatePots(gameState.players);
    finalizeAction();
}

// 1.2: 重写 finalizeAction() 逻辑
function finalizeAction() {
    const active = gameState.players.filter(pl => pl.status === 'active');
    const allIn = gameState.players.filter(pl => pl.status === 'all-in');
    const survivors = [...active, ...allIn];

    // 1) 只剩一个非 fold 玩家 → fold-win
    if (survivors.length <= 1) {
        if (survivors.length === 1) {
            return settleWinnersByFold(survivors[0]);
        }
        // 0 survivors shouldn't happen, but handle gracefully
        return showdown();
    }

    // 2) 没有 active 玩家（全部 all-in 或 fold）→ runout
    if (active.length === 0) {
        return autoFinish();
    }

    // 3) 只剩 1 个 active + N 个 all-in:
    //    如果该 active 玩家已经行动完（!needsToAct 且 currentBet 匹配），直接 runout
    if (active.length === 1 && allIn.length >= 1) {
        const solo = active[0];
        if (!solo.needsToAct && solo.currentBet >= gameState.currentBet) {
            return autoFinish();
        }
        // 否则该玩家还需要行动（比如面对一个 all-in 加注），继续
    }

    // 4) 检查本轮是否结束：所有 active 玩家都 !needsToAct 且 currentBet 匹配
    const roundOver = active.every(pl => {
        return !pl.needsToAct && pl.currentBet === gameState.currentBet;
    });

    if (roundOver) {
        advanceRound();
    } else {
        moveToNext();
    }
}

function advanceRound() {
    if (gameState.round === 'river') return showdown();

    gameState.players.forEach(p => {
        p.currentBet = 0;
        p.lastAction = "";
        if (p.status === 'active') {
            p.needsToAct = true;
        }
    });
    gameState.currentBet = 0;
    gameState.minRaise = CONFIG.BIG_BLIND;

    if (gameState.round === 'pre-flop') {
        gameState.round = 'flop';
        for (let i = 0; i < 3; i++) {
            gameState.communityCards.push(gameState.deck.pop());
        }
    } else if (gameState.round === 'flop') {
        gameState.round = 'turn';
        gameState.communityCards.push(gameState.deck.pop());
    } else if (gameState.round === 'turn') {
        gameState.round = 'river';
        gameState.communityCards.push(gameState.deck.pop());
    }

    // 1.4: 从庄家后第一个位置开始，moveToNext 会跳过非 active 玩家
    moveToNext((gameState.dealerIdx + 1) % gameState.players.length);
}

function showdown() {
    gameState.round = 'showdown';
    broadcastState();

    const results = Engine.determineWinners(gameState.pots, gameState.players, gameState.communityCards);
    results.forEach(r => {
        const pl = gameState.players.find(p => p.id === r.id);
        if (pl) {
            pl.chips += r.amount;
            // 1.8: 只在结算时批量更新 DB
            DB.updateUserChips(pl.name, pl.chips);
        }
    });

    DB.addLedgerEntry(
        results.map(r => r.name).join(','),
        results.reduce((s, r) => s + r.amount, 0),
        results[0]?.handName || "比牌"
    );
    gameState.ledger = DB.getRecentLedger();
    io.emit('game_result', { details: results, ledger: gameState.ledger });

    setTimeout(() => {
        gameState.dealerIdx = (gameState.dealerIdx + 1) % gameState.players.length;
        gameState.round = 'waiting';
        broadcastState();
    }, 6000);
}

function settleWinnersByFold(winner) {
    const tot = gameState.pots.reduce((s, p) => s + p.amount, 0);
    winner.chips += tot;
    // 1.8: 只在结算时更新 DB
    DB.updateUserChips(winner.name, winner.chips);

    DB.addLedgerEntry(winner.name, tot, "对手弃牌");
    gameState.ledger = DB.getRecentLedger();
    io.emit('game_result', {
        details: [{ name: winner.name, amount: tot, handName: "对手弃牌" }],
        ledger: gameState.ledger
    });

    setTimeout(() => {
        gameState.dealerIdx = (gameState.dealerIdx + 1) % gameState.players.length;
        gameState.round = 'waiting';
        broadcastState();
    }, 4000);
}

// --- 辅助逻辑 ---

// 1.8: investChips 不再写 DB，仅内存操作
function investChips(p, amount, label) {
    const act = Math.min(p.chips, amount);
    p.chips -= act;
    p.currentBet += act;
    p.totalHandInvestment += act;
    if (label) p.lastAction = label;
    if (p.chips === 0 && act > 0) {
        p.status = 'all-in';
        p.lastAction = 'ALL-IN';
        p.needsToAct = false;
    }
}

// 1.6: moveToNext 使用 players.length 作为上限，溢出时 autoFinish
function moveToNext(seed) {
    const len = gameState.players.length;
    if (seed !== undefined) {
        gameState.activeSeat = seed;
    } else {
        gameState.activeSeat = (gameState.activeSeat + 1) % len;
    }

    let attempts = 0;
    while (gameState.players[gameState.activeSeat].status !== 'active' && attempts < len) {
        gameState.activeSeat = (gameState.activeSeat + 1) % len;
        attempts++;
    }

    // 如果循环一圈都没找到 active 玩家
    if (attempts >= len || gameState.players[gameState.activeSeat].status !== 'active') {
        return autoFinish();
    }

    broadcastState();
    startTimer();
}

function autoFinish() {
    while (gameState.communityCards.length < 5) {
        gameState.communityCards.push(gameState.deck.pop());
    }
    showdown();
}

// 1.7: 使用 4 字节 crypto.randomBytes 消除模偏差
function createDeck() {
    const suits = ['♥', '♠', '♦', '♣'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let s of suits) {
        for (let v of values) {
            deck.push({ value: v, suit: s, color: (s === '♥' || s === '♦') ? 'red' : 'black' });
        }
    }
    // Fisher-Yates with 32-bit random
    for (let i = deck.length - 1; i > 0; i--) {
        const buf = crypto.randomBytes(4);
        const rand = buf.readUInt32BE(0);
        const j = rand % (i + 1);
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function broadcastState() {
    gameState.players.forEach(p => {
        io.to(p.id).emit('update_state', sanitizeState(gameState, p.id));
    });
    gameState.spectators.forEach(s => {
        io.to(s.id).emit('update_state', sanitizeState(gameState, null));
    });
}

function sanitizeState(s, vid) {
    return {
        ...s,
        players: s.players.map(p => ({
            ...p,
            hand: (p.id === vid || s.round === 'showdown') ? p.hand : ['?', '?']
        })),
        timer: null
    };
}

function startTimer() {
    if (gameState.timer) clearTimeout(gameState.timer);
    gameState.timer = setTimeout(() => {
        const p = gameState.players[gameState.activeSeat];
        if (p) handleAction(p.id, { type: 'fold' });
    }, CONFIG.TURN_TIME);
}

// 1.1: PORT 定义
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`ACE PRO v12 - 9-Seat Edition on port ${PORT}`));
