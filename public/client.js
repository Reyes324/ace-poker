const socket = io();

// 全局变量
let myId = null;
let currentLedger = [];
let lastState = null;
let lastCommunityCount = 0;

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
window.onFold = () => socket.emit('player_action', { type: 'fold' });
window.onCall = () => { socket.emit('player_action', { type: 'call' }); animateChips(meArea); };
window.onRaiseOpen = () => {
    if (!lastState) return;
    const minNeeded = lastState.currentBet + lastState.minRaise;
    raiseInput.value = minNeeded;
    raiseModal.style.display = 'flex';
    raiseInput.focus();
};
window.confirmRaise = () => {
    const amt = parseInt(raiseInput.value);
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
    myId = socket.id; lastState = state;
    const nick = localStorage.getItem('poker_nick');
    const me = state.players.find(p => p.name === nick);
    const meIdx = state.players.findIndex(p => p.name === nick);

    potVal.innerText = `¥ ${state.pots.reduce((s, p) => s + p.amount, 0)}`;
    sidePotsDiv.innerHTML = state.pots.length > 1 ? state.pots.slice(1).map((p, i) => `边池${i+1}: ¥${p.amount}`).join(' | ') : '';

    if (state.communityCards.length > lastCommunityCount) renderCards(commDiv, state.communityCards, true);
    else renderCards(commDiv, state.communityCards, false);
    lastCommunityCount = state.communityCards.length;
    if (state.round === 'waiting') lastCommunityCount = 0;

    if (!me) {
        btnSit.style.display = 'flex'; btnStartNow.style.display = 'none';
        setBtnsVisibility(false);
        hint.innerText = "👀 正在旁观...";
    } else {
        btnSit.style.display = 'none';
        myVal.innerText = `¥ ${me.chips}`; topChips.innerText = `¥ ${me.chips}`;
        renderCards(myHand, me.hand);

        if (state.round === 'waiting') {
            setBtnsVisibility(false);
            if (meIdx === state.dealerIdx && state.players.length >= 2) btnStartNow.style.display = 'flex';
            else btnStartNow.style.display = 'none';
            hint.innerText = "等待开始...";
        } else {
            btnStartNow.style.display = 'none';
            setBtnsVisibility(true);
            const activePlayer = state.players[state.activeSeat];
            const isMyTurn = (activePlayer && activePlayer.name === nick);
            if (isMyTurn && me.status === 'active') {
                const diff = state.currentBet - me.currentBet;
                btnC.innerHTML = diff > 0 ? `跟注<span class="btn-s">CALL ${diff}</span>` : `看牌<span class="btn-s">CHECK</span>`;
                enableActionBtns(true);
                hint.innerText = "★ 您的回合"; hint.style.color = "var(--gold)";
            } else {
                enableActionBtns(false);
                hint.innerText = me.status === 'folded' ? "已弃牌" : `轮次: ${state.round.toUpperCase()}`;
                hint.style.color = "#8e8e93";
            }
        }
        if (me.lastAction) { myActionBubble.innerText = me.lastAction; myActionBubble.classList.add('show'); }
        else { myActionBubble.classList.remove('show'); }
    }
    updateSeats(state.players, state.activeSeat, state.dealerIdx);
});

function updateSeats(players, activeIdx, dealerIdx) {
    const seats = ['seat-l1', 'seat-l2', 'seat-top', 'seat-r2', 'seat-r1'];
    seats.forEach(s => {
        const el = document.getElementById(s); el.classList.remove('occupied', 'active');
        el.querySelector('.action-bubble').classList.remove('show');
        const dt = el.querySelector('.dealer-tag'); if(dt) dt.remove();
        const at = el.querySelector('.allin-tag'); if(at) at.remove();
    });
    
    // 清理本人位标记
    const mdt = meArea.querySelector('.dealer-tag'); if(mdt) mdt.remove();
    const mat = meArea.querySelector('.allin-tag'); if(mat) mat.remove();

    let sIdx = 0;
    players.forEach((p, idx) => {
        const nick = localStorage.getItem('poker_nick');
        const isMe = (p.name === nick);
        let targetAvatar;

        if (isMe) {
            if (idx === activeIdx) meArea.classList.add('active'); else meArea.classList.remove('active');
            meArea.style.opacity = (p.status === 'folded' || !p.connected) ? '0.3' : '1';
            targetAvatar = meArea.querySelector('.my-avatar');
        } else {
            const el = document.getElementById(seats[sIdx]);
            if (el) {
                el.classList.add('occupied'); if (idx === activeIdx) el.classList.add('active');
                el.querySelector('.avatar span').innerText = p.connected ? p.name[0] : '断';
                el.querySelector('.p-name').innerText = p.name;
                el.querySelector('.p-chips').innerText = `¥ ${p.chips}`;
                if (p.lastAction) { const ab = el.querySelector('.action-bubble'); ab.innerText = p.lastAction; ab.classList.add('show'); }
                el.style.opacity = (p.status === 'folded' || !p.connected) ? '0.3' : '1';
                targetAvatar = el.querySelector('.avatar');
                sIdx++;
            }
        }

        if (targetAvatar) {
            // 渲染“庄”标记
            if (idx === dealerIdx) {
                const d = document.createElement('div'); d.className='dealer-tag'; d.innerText='庄';
                d.style="position:absolute; bottom:-4px; right:-4px; width:18px; height:18px; background:var(--gold); color:#000; border-radius:50%; font-size:10px; font-weight:900; display:flex; align-items:center; justify-content:center; border:1.5px solid #000; z-index:10;";
                targetAvatar.appendChild(d);
            }
            // 渲染 ALL-IN 标记
            if (p.status === 'all-in') {
                const a = document.createElement('div'); a.className='allin-tag'; a.innerText='ALL-IN';
                a.style="position:absolute; top:-6px; left:50%; transform:translateX(-50%); background:var(--danger); color:white; font-size:8px; padding:1px 4px; border-radius:4px; font-weight:900; white-space:nowrap; z-index:11;";
                targetAvatar.appendChild(a);
            }
        }
    });
}

// 其余辅助逻辑 (renderCards, renderLedger, animateChips, etc.) 保持一致...
function setBtnsVisibility(v) { [btnF, btnC, btnR].forEach(b => b.style.display = v ? 'flex' : 'none'); }
function enableActionBtns(on) { [btnF, btnC, btnR].forEach(b => { b.style.opacity = on ? '1' : '0.4'; b.style.pointerEvents = on ? 'auto' : 'none'; }); }
function renderCards(container, cards, animateNew = false) {
    const currentCardEls = container.querySelectorAll('.card');
    if (currentCardEls.length === cards.length && !animateNew) return;
    container.innerHTML = '';
    cards.forEach((c, i) => {
        const div = document.createElement('div'); div.className = 'card';
        div.innerHTML = `<div class="card-inner"><div class="card-back"></div><div class="card-front ${c.color === 'red' ? 'red' : ''}"><span class="v">${c==='?'?'':c.value}</span><span class="s">${c==='?'?'':c.suit}</span></div></div>`;
        if (c !== '?' && (!animateNew || i < lastCommunityCount)) div.classList.add('flipped');
        if (animateNew && i >= lastCommunityCount) setTimeout(() => div.classList.add('flipped'), i * 200 + 100);
        container.appendChild(div);
    });
}
function renderLedger(d) {
    ledgerList.innerHTML = d.length ? '' : '<div style="text-align:center; color:#666; margin-top:50px;">暂无记录</div>';
    d.forEach(item => {
        const row = document.createElement('div'); row.style="background:#1c1c1e; padding:15px; border-radius:12px; display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;";
        row.innerHTML = `<div><div style="font-size:11px; color:#666;">${item.time}</div><div style="font-weight:600;">${item.winners}</div><div style="font-size:11px; color:var(--gold);">${item.handType}</div></div><div style="font-size:18px; font-weight:800; color:var(--gold);">+¥${item.totalWin}</div>`;
        ledgerList.appendChild(row);
    });
}
function animateChips(fromEl) {
    const chip = document.createElement('div'); chip.className = 'anim-chip';
    const av = fromEl.querySelector('.avatar, .my-avatar'); if(!av) return;
    const rect = av.getBoundingClientRect(); chip.style.top = rect.top + 'px'; chip.style.left = rect.left + 'px';
    document.body.appendChild(chip); setTimeout(() => chip.remove(), 500);
}
socket.on('deal_cards', () => {
    setTimeout(() => {
        const pEls = document.querySelectorAll('.occupied, .my-area');
        pEls.forEach((p, i) => {
            const rect = p.querySelector('.avatar, .my-avatar').getBoundingClientRect();
            for (let j=0; j<2; j++) {
                setTimeout(() => {
                    const c = document.createElement('div'); c.className = 'card anim-card';
                    c.innerHTML = '<div class="card-inner"><div class="card-back"></div></div>';
                    c.style.top = rect.top + 'px'; c.style.left = rect.left + 'px';
                    document.body.appendChild(c); setTimeout(() => c.remove(), 700);
                }, (i*200)+(j*100));
            }
        });
    }, 100);
});
socket.on('room_stats', (s) => { if (s.ledger) currentLedger = s.ledger; });
socket.on('game_result', (res) => {
    if (res.ledger) currentLedger = res.ledger;
    resCards.innerHTML = ''; resOverlay.style.display = 'flex';
    res.details.forEach(item => {
        const row = document.createElement('div'); row.style = "background: rgba(255,255,255,0.1); padding: 15px; border-radius: 12px; border-left: 4px solid var(--gold);";
        row.innerHTML = `<div style="display:flex; justify-content:space-between;"><b>${item.name}</b><span style="color:var(--gold)">+¥${item.amount}</span></div><div style="font-size:11px; color:#888;">${item.handName}</div>`;
        resCards.appendChild(row);
    });
    setTimeout(() => { resOverlay.style.display = 'none'; }, 4500);
});
const SAVED_NICK = localStorage.getItem('poker_nick');
if (SAVED_NICK) socket.emit('join_req', SAVED_NICK);
