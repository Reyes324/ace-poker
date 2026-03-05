const socket = io();

// 全局变量
let myId = null;
let currentLedger = [];
let lastState = null;
let lastCommunityCount = 0;
let lastHandId = 0; // 用于检测新一局

// DOM 引用
const login = document.getElementById('login');
const nickInput = document.getElementById('nick');
const hint = document.getElementById('hint');
const potVal = document.getElementById('pot');
const sidePotsDiv = document.getElementById('side-pots');
const commDiv = document.getElementById('comm');
const myName = document.getElementById('my-name');
const myVal = document.getElementById('my-val');
const topChips = document.getElementById('top-chips');
const myHand = document.getElementById('my-hand');
const meArea = document.getElementById('me-area');
const myActionBubble = document.getElementById('my-action');
const btnSit = document.getElementById('btn-sit');
const btnStartNow = document.getElementById('btn-start-now');
const btnRebuy = document.getElementById('btn-rebuy');
const btnF = document.getElementById('f');
const btnC = document.getElementById('c');
const btnR = document.getElementById('r');
const raiseModal = document.getElementById('raise-modal');
const raiseInput = document.getElementById('raise-input');
const ledgerOverlay = document.getElementById('ledger-overlay');
const ledgerList = document.getElementById('ledger-list');
const resOverlay = document.getElementById('result-overlay');
const resCards = document.getElementById('result-cards');

// --- A. 全局事件 ---

window.onLogin = () => {
    const n = nickInput.value.trim();
    if (n) { socket.emit('join_req', n); setTimeout(() => socket.emit('sit_down', n), 200); }
};
window.onSitDown = () => { socket.emit('sit_down', localStorage.getItem('poker_nick')); };
window.onStartHand = () => socket.emit('start_hand');
window.onRebuy = () => socket.emit('rebuy');
window.onFold = () => socket.emit('player_action', { type: 'fold' });
window.onCall = () => { socket.emit('player_action', { type: 'call' }); animateChips(meArea); };
window.onRaiseOpen = () => {
    if (!lastState) return;
    const minNeeded = lastState.currentBet + lastState.minRaise;
    raiseInput.value = minNeeded;
    raiseModal.style.display = 'flex';
    raiseInput.focus();
};
// 3.4: confirmRaise 增加验证
window.confirmRaise = () => {
    const amt = parseInt(raiseInput.value);
    if (isNaN(amt) || amt <= 0) {
        raiseInput.style.borderColor = 'var(--danger)';
        setTimeout(() => { raiseInput.style.borderColor = 'var(--gold)'; }, 1000);
        return;
    }
    const me = lastState && lastState.players.find(p => p.name === localStorage.getItem('poker_nick'));
    if (me) {
        const minNeeded = lastState.currentBet + lastState.minRaise;
        const maxAllowed = me.chips + me.currentBet;
        if (amt < minNeeded && amt < maxAllowed) {
            raiseInput.value = minNeeded;
            raiseInput.style.borderColor = 'var(--danger)';
            setTimeout(() => { raiseInput.style.borderColor = 'var(--gold)'; }, 1000);
            return;
        }
        if (amt > maxAllowed) {
            raiseInput.value = maxAllowed;
            return;
        }
    }
    socket.emit('player_action', { type: 'raise', amount: amt });
    raiseModal.style.display = 'none';
    animateChips(meArea);
};
window.closeRaiseModal = () => { raiseModal.style.display = 'none'; };
window.setRaiseRate = (rate) => {
    if (!lastState) return;
    const totalPot = lastState.pots.reduce((s, p) => s + p.amount, 0);
    const minNeeded = lastState.currentBet + lastState.minRaise;
    raiseInput.value = Math.max(Math.floor(totalPot * rate), minNeeded);
};
window.setRaiseAllIn = () => {
    const me = lastState.players.find(p => p.name === localStorage.getItem('poker_nick'));
    if (me) raiseInput.value = me.chips + me.currentBet;
};
window.openLedger = () => { renderLedger(currentLedger); ledgerOverlay.style.display = 'flex'; };
window.closeLedger = () => { ledgerOverlay.style.display = 'none'; };

// --- B. 渲染核心 ---

socket.on('login_success', (data) => {
    localStorage.setItem('poker_nick', data.name);
    login.style.display = 'none';
    myName.innerText = data.name;
});

socket.on('update_state', (state) => {
    myId = socket.id;
    lastState = state;
    const nick = localStorage.getItem('poker_nick');
    const me = state.players.find(p => p.name === nick);
    const meIdx = state.players.findIndex(p => p.name === nick);

    potVal.innerText = `¥ ${state.pots.reduce((s, p) => s + p.amount, 0)}`;
    sidePotsDiv.innerHTML = state.pots.length > 1
        ? state.pots.slice(1).map((p, i) => `边池${i + 1}: ¥${p.amount}`).join(' | ')
        : '';

    // 3.1: 修复连续两局牌面相同 - 在 waiting 切换时强制清空
    if (state.round === 'waiting') {
        if (lastCommunityCount > 0) {
            commDiv.innerHTML = '';
        }
        lastCommunityCount = 0;
    }

    if (state.communityCards.length > lastCommunityCount) {
        renderCards(commDiv, state.communityCards, true);
    } else {
        renderCards(commDiv, state.communityCards, false);
    }
    if (state.round !== 'waiting') {
        lastCommunityCount = state.communityCards.length;
    }

    if (!me) {
        btnSit.style.display = 'flex';
        btnStartNow.style.display = 'none';
        if (btnRebuy) btnRebuy.style.display = 'none';
        setActionBtns(false, false);
        hint.innerText = "正在旁观...";
    } else {
        btnSit.style.display = 'none';
        myVal.innerText = `¥ ${me.chips}`;
        topChips.innerText = `¥ ${me.chips}`;

        // 3.1: 强制刷新手牌 - 新一局时清空容器
        if (state.round === 'waiting') {
            myHand.innerHTML = '';
        } else {
            renderCards(myHand, me.hand);
        }

        if (state.round === 'waiting') {
            setActionBtns(false, false);
            if (meIdx === state.dealerIdx && state.players.length >= 2) {
                btnStartNow.style.display = 'flex';
            } else {
                btnStartNow.style.display = 'none';
            }
            // 5.2: rebuy 按钮 - 筹码为 0 且等待中时显示
            if (btnRebuy) {
                if (me.chips === 0) {
                    btnRebuy.style.display = 'flex';
                } else {
                    btnRebuy.style.display = 'none';
                }
            }
            hint.innerText = "等待开始...";
        } else {
            btnStartNow.style.display = 'none';
            if (btnRebuy) btnRebuy.style.display = 'none';
            const activePlayer = state.players[state.activeSeat];
            const isMyTurn = (activePlayer && activePlayer.name === nick);
            if (isMyTurn && me.status === 'active') {
                const diff = state.currentBet - me.currentBet;
                btnC.innerHTML = diff > 0
                    ? `跟注<span class="btn-s">CALL ${diff}</span>`
                    : `看牌<span class="btn-s">CHECK</span>`;
                // 3.3: 统一按钮控制 - 显示且可点击
                setActionBtns(true, true);
                hint.innerText = "★ 您的回合";
                hint.style.color = "var(--gold)";
            } else {
                // 3.3: 显示但不可点击
                setActionBtns(true, false);
                hint.innerText = me.status === 'folded' ? "已弃牌" : `轮次: ${state.round.toUpperCase()}`;
                hint.style.color = "#8e8e93";
            }
        }
        if (me.lastAction) {
            myActionBubble.innerText = me.lastAction;
            myActionBubble.classList.add('show');
        } else {
            myActionBubble.classList.remove('show');
        }
    }
    updateSeats(state.players, state.activeSeat, state.dealerIdx);
});

// 3.3: 统一按钮状态控制 - 一套逻辑
function setActionBtns(visible, enabled) {
    [btnF, btnC, btnR].forEach(b => {
        b.style.display = visible ? 'flex' : 'none';
        b.style.opacity = enabled ? '1' : '0.4';
        b.style.pointerEvents = enabled ? 'auto' : 'none';
    });
}

// 4.3: 9 座 updateSeats 重构
function updateSeats(players, activeIdx, dealerIdx) {
    const seatIds = ['seat-1', 'seat-2', 'seat-3', 'seat-4', 'seat-5', 'seat-6', 'seat-7', 'seat-8'];

    // 清理所有座位
    seatIds.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.remove('occupied', 'active');
        el.querySelector('.action-bubble').classList.remove('show');
        const dt = el.querySelector('.dealer-tag');
        if (dt) dt.remove();
        const at = el.querySelector('.allin-tag');
        if (at) at.remove();
    });

    // 清理本人位标记
    const mdt = meArea.querySelector('.dealer-tag');
    if (mdt) mdt.remove();
    const mat = meArea.querySelector('.allin-tag');
    if (mat) mat.remove();

    const nick = localStorage.getItem('poker_nick');
    const meIdx = players.findIndex(p => p.name === nick);

    // 分离"我"和其他玩家
    let others = [];
    players.forEach((p, idx) => {
        if (p.name !== nick) {
            others.push({ player: p, originalIdx: idx });
        }
    });

    // 将对手均匀分配到 8 个座位上
    // 对手按顺序（从"我"之后开始）填入座位
    let seatAssignment = [];
    if (others.length <= 8) {
        // 均匀分布：根据对手数量选择座位位置
        const totalSeats = 8;
        if (others.length === 1) {
            seatAssignment = [4]; // 正对面 (seat-5, index 4)
        } else if (others.length === 2) {
            seatAssignment = [2, 6]; // 左上、右上
        } else if (others.length === 3) {
            seatAssignment = [1, 4, 7]; // 均分三个位置
        } else if (others.length === 4) {
            seatAssignment = [1, 3, 5, 7]; // 四个均分
        } else if (others.length === 5) {
            seatAssignment = [1, 2, 4, 6, 7]; // 五个
        } else if (others.length === 6) {
            seatAssignment = [0, 1, 3, 4, 6, 7]; // 六个
        } else if (others.length === 7) {
            seatAssignment = [0, 1, 2, 4, 5, 6, 7]; // 七个
        } else {
            seatAssignment = [0, 1, 2, 3, 4, 5, 6, 7]; // 八个全满
        }
    }

    // 渲染"我"
    if (meIdx >= 0) {
        const me = players[meIdx];
        if (meIdx === activeIdx) meArea.classList.add('active');
        else meArea.classList.remove('active');
        meArea.style.opacity = (me.status === 'folded' || !me.connected) ? '0.3' : '1';
        const targetAvatar = meArea.querySelector('.my-avatar');
        renderPlayerTag(targetAvatar, meIdx, dealerIdx, me);
    }

    // 渲染对手
    others.forEach((o, i) => {
        if (i >= seatAssignment.length) return;
        const seatIndex = seatAssignment[i];
        const el = document.getElementById(seatIds[seatIndex]);
        if (!el) return;

        const p = o.player;
        const idx = o.originalIdx;

        el.classList.add('occupied');
        if (idx === activeIdx) el.classList.add('active');

        el.querySelector('.avatar span').innerText = p.connected ? p.name[0] : '断';
        el.querySelector('.p-name').innerText = p.name;
        el.querySelector('.p-chips').innerText = `¥ ${p.chips}`;

        if (p.lastAction) {
            const ab = el.querySelector('.action-bubble');
            ab.innerText = p.lastAction;
            ab.classList.add('show');
        }

        el.style.opacity = (p.status === 'folded' || !p.connected) ? '0.3' : '1';
        const targetAvatar = el.querySelector('.avatar');
        renderPlayerTag(targetAvatar, idx, dealerIdx, p);
    });
}

function renderPlayerTag(targetAvatar, idx, dealerIdx, p) {
    if (!targetAvatar) return;
    if (idx === dealerIdx) {
        const d = document.createElement('div');
        d.className = 'dealer-tag';
        d.innerText = '庄';
        targetAvatar.appendChild(d);
    }
    if (p.status === 'all-in') {
        const a = document.createElement('div');
        a.className = 'allin-tag';
        a.innerText = 'ALL-IN';
        targetAvatar.appendChild(a);
    }
}

// 3.1 + 3.2: 修复 renderCards
function renderCards(container, cards, animateNew = false) {
    // 不再 early return - 每次都重新渲染以避免缓存问题
    if (!cards || cards.length === 0) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = '';
    cards.forEach((c, i) => {
        const div = document.createElement('div');
        div.className = 'card';

        // 3.2: 安全处理 '?' 卡牌
        if (typeof c === 'string' || !c || !c.value) {
            div.innerHTML = '<div class="card-inner"><div class="card-back"></div><div class="card-front"><span class="v"></span><span class="s"></span></div></div>';
        } else {
            const isRed = c.color === 'red';
            div.innerHTML = `<div class="card-inner"><div class="card-back"></div><div class="card-front ${isRed ? 'red' : ''}"><span class="v">${c.value}</span><span class="s">${c.suit}</span></div></div>`;
            if (!animateNew || i < lastCommunityCount) {
                div.classList.add('flipped');
            }
            if (animateNew && i >= lastCommunityCount) {
                setTimeout(() => div.classList.add('flipped'), i * 200 + 100);
            }
        }
        container.appendChild(div);
    });
}

function renderLedger(d) {
    ledgerList.innerHTML = d.length ? '' : '<div style="text-align:center; color:#666; margin-top:50px;">暂无记录</div>';
    d.forEach(item => {
        const row = document.createElement('div');
        row.style = "background:#1c1c1e; padding:15px; border-radius:12px; display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;";
        row.innerHTML = `<div><div style="font-size:11px; color:#666;">${item.time}</div><div style="font-weight:600;">${item.winners}</div><div style="font-size:11px; color:var(--gold);">${item.handType}</div></div><div style="font-size:18px; font-weight:800; color:var(--gold);">+¥${item.totalWin}</div>`;
        ledgerList.appendChild(row);
    });
}

// 3.5: animateChips 修复
function animateChips(fromEl) {
    const chip = document.createElement('div');
    chip.className = 'anim-chip';
    const av = fromEl.querySelector('.avatar, .my-avatar');
    if (!av) return;
    const rect = av.getBoundingClientRect();
    chip.style.position = 'fixed';
    chip.style.top = rect.top + 'px';
    chip.style.left = rect.left + 'px';
    chip.style.zIndex = '1000';
    document.body.appendChild(chip);
    setTimeout(() => chip.remove(), 500);
}

socket.on('deal_cards', () => {
    // 清空手牌容器以准备新一局
    myHand.innerHTML = '';
    setTimeout(() => {
        const pEls = document.querySelectorAll('.occupied, .my-area');
        pEls.forEach((p, i) => {
            const av = p.querySelector('.avatar, .my-avatar');
            if (!av) return;
            const rect = av.getBoundingClientRect();
            for (let j = 0; j < 2; j++) {
                setTimeout(() => {
                    const c = document.createElement('div');
                    c.className = 'card anim-card';
                    c.innerHTML = '<div class="card-inner"><div class="card-back"></div></div>';
                    c.style.top = rect.top + 'px';
                    c.style.left = rect.left + 'px';
                    document.body.appendChild(c);
                    setTimeout(() => c.remove(), 700);
                }, (i * 200) + (j * 100));
            }
        });
    }, 100);
});

socket.on('room_stats', (s) => { if (s.ledger) currentLedger = s.ledger; });

socket.on('game_result', (res) => {
    if (res.ledger) currentLedger = res.ledger;
    resCards.innerHTML = '';
    resOverlay.style.display = 'flex';
    res.details.forEach(item => {
        const row = document.createElement('div');
        row.style = "background: rgba(255,255,255,0.1); padding: 15px; border-radius: 12px; border-left: 4px solid var(--gold);";
        row.innerHTML = `<div style="display:flex; justify-content:space-between;"><b>${item.name}</b><span style="color:var(--gold)">+¥${item.amount}</span></div><div style="font-size:11px; color:#888;">${item.handName}</div>`;
        resCards.appendChild(row);
    });
    setTimeout(() => { resOverlay.style.display = 'none'; }, 4500);
});

const SAVED_NICK = localStorage.getItem('poker_nick');
if (SAVED_NICK) socket.emit('join_req', SAVED_NICK);
