const socket = io();

// DOM 引用
const login = document.getElementById('login');
const nickInput = document.getElementById('nick');
const goBtn = document.getElementById('go');
const watchBtn = document.getElementById('watch-btn');
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
const resOverlay = document.getElementById('result-overlay');
const resCards = document.getElementById('result-cards');
const btnLedger = document.getElementById('btn-ledger');
const ledgerOverlay = document.getElementById('ledger-overlay');
const ledgerClose = document.getElementById('ledger-close');
const ledgerList = document.getElementById('ledger-list');
const raiseModal = document.getElementById('raise-modal');
const raiseInput = document.getElementById('raise-input');
const minRaiseHint = document.getElementById('min-raise-hint');

let myId = null;
let currentLedger = [];
let lastState = null;
let lastCommunityCount = 0;

// --- A. 身份持久化与自动重连 ---

const SAVED_NICK = localStorage.getItem('poker_nick');
if (SAVED_NICK) {
    socket.emit('join_req', SAVED_NICK);
}

socket.on('login_success', (data) => {
    localStorage.setItem('poker_nick', data.name);
    login.style.display = 'none';
    myName.innerText = data.name;
});

goBtn.onclick = () => {
    const n = nickInput.value.trim();
    if (n) {
        socket.emit('sit_down', n); // 这里的逻辑改为：如果没登录先登录
        // 实际上后端支持直接 join_req 后坐下，这里为了兼容老流程先 join
        socket.emit('join_req', n);
        setTimeout(() => socket.emit('sit_down', n), 200);
    }
};

watchBtn.onclick = () => {
    const n = nickInput.value.trim();
    socket.emit('join_req', n || '旁观者');
};

btnSit.onclick = () => {
    const n = myName.innerText;
    socket.emit('sit_down', n);
};

// --- B. 状态渲染逻辑 ---

socket.on('update_state', (state) => {
    myId = socket.id;
    lastState = state;
    const me = state.players.find(p => p.id === myId || p.name === localStorage.getItem('poker_nick'));
    const meIdx = state.players.findIndex(p => p.id === (me ? me.id : ''));

    // 渲染公共牌
    const isNewCards = state.communityCards.length > lastCommunityCount;
    renderCards(commDiv, state.communityCards, isNewCards);
    lastCommunityCount = state.communityCards.length;
    if (state.round === 'waiting') lastCommunityCount = 0;

    potVal.innerText = `¥ ${state.pots.reduce((sum, p) => sum + p.amount, 0)}`;

    if (!me) {
        btnSit.style.display = 'flex'; btnStartNow.style.display = 'none';
        [btnF, btnC, btnR].forEach(b => b.style.display = 'none');
        hint.innerText = "👀 正在旁观...";
    } else {
        btnSit.style.display = 'none';
        myVal.innerText = `¥ ${me.chips}`; topChips.innerText = `¥ ${me.chips}`;
        renderCards(myHand, me.hand);

        if (state.round === 'waiting') {
            [btnF, btnC, btnR].forEach(b => b.style.display = 'none');
            if (meIdx === state.dealerIdx && state.players.length >= 2) {
                btnStartNow.style.display = 'flex'; hint.innerText = "人数已够，开始发牌";
            } else {
                btnStartNow.style.display = 'none'; hint.innerText = "等待房主开始...";
            }
        } else {
            btnStartNow.style.display = 'none';
            [btnF, btnC, btnR].forEach(b => b.style.display = 'flex');
            
            const activePlayer = state.players[state.activeSeat];
            const isMyTurn = (activePlayer && (activePlayer.id === myId || activePlayer.name === me.name));
            
            if (isMyTurn) {
                hint.innerText = "★ 您的回合"; hint.style.color = "var(--gold)";
                const diff = state.currentBet - me.currentBet;
                btnC.querySelector('.btn-s').innerText = diff > 0 ? `CALL ${diff}` : 'CHECK';
                btnC.childNodes[0].nodeValue = diff > 0 ? '跟注' : '看牌';
                enableActionBtns(true);
            } else {
                hint.innerText = `轮次: ${state.round.toUpperCase()}`; hint.style.color = "#8e8e93";
                enableActionBtns(false);
            }
        }
        
        if (me.lastAction) { myActionBubble.innerText = me.lastAction; myActionBubble.classList.add('show'); }
        else { myActionBubble.classList.remove('show'); }
        meArea.style.opacity = (me.status === 'folded' || !me.connected) ? '0.3' : '1';
    }

    updateSeats(state.players, state.activeSeat, state.dealerIdx);
});

// --- C. 动画与 UI 同步 (其余代码保持 v5 逻辑) ---

function renderCards(container, cards, animateNew = false) {
    const currentCardEls = container.querySelectorAll('.card');
    if (currentCardEls.length === cards.length && !animateNew) return;
    container.innerHTML = '';
    cards.forEach((c, i) => {
        const div = document.createElement('div'); div.className = 'card';
        div.innerHTML = `<div class="card-inner"><div class="card-back"></div><div class="card-front ${c.color === 'red' ? 'red' : ''}"><span class="v">${c === '?' ? '' : c.value}</span><span class="s">${c === '?' ? '' : c.suit}</span></div></div>`;
        if (c !== '?' && (!animateNew || i < lastCommunityCount)) div.classList.add('flipped');
        if (animateNew && i >= lastCommunityCount) setTimeout(() => div.classList.add('flipped'), i * 200 + 100);
        container.appendChild(div);
    });
}

function updateSeats(players, activeIdx, dealerIdx) {
    const seats = ['seat-l1', 'seat-l2', 'seat-top', 'seat-r2', 'seat-r1'];
    seats.forEach(s => {
        const el = document.getElementById(s); el.classList.remove('occupied', 'active');
        el.querySelector('.action-bubble').classList.remove('show');
        const d = el.querySelector('.dealer-tag'); if(d) d.remove();
        const a = el.querySelector('.allin-tag'); if(a) a.remove();
    });
    let sIdx = 0;
    players.forEach((p, idx) => {
        const isMe = (p.id === myId || p.name === localStorage.getItem('poker_nick'));
        if (isMe) {
            if (idx === activeIdx) meArea.classList.add('active'); else meArea.classList.remove('active');
            if (!p.connected) meArea.style.filter = 'grayscale(1)'; else meArea.style.filter = 'none';
        } else {
            const el = document.getElementById(seats[sIdx]);
            if (el) {
                el.classList.add('occupied'); if (idx === activeIdx) el.classList.add('active');
                el.querySelector('.avatar span').innerText = p.connected ? p.name[0] : '断';
                el.querySelector('.p-name').innerText = p.name + (p.connected ? '' : '(离线)');
                el.querySelector('.p-chips').innerText = `¥ ${p.chips}`;
                if (p.lastAction) { const ab = el.querySelector('.action-bubble'); ab.innerText = p.lastAction; ab.classList.add('show'); }
                el.style.opacity = (p.status === 'folded' || !p.connected) ? '0.3' : '1';
                if (p.status === 'all-in') { const a = document.createElement('div'); a.className='allin-tag'; a.innerText='ALL-IN'; a.style="position:absolute; top:-5px; background:var(--danger); color:white; font-size:8px; padding:2px 4px; border-radius:4px;"; el.querySelector('.avatar').appendChild(a); }
                if (idx === dealerIdx) { const d = document.createElement('div'); d.className='dealer-tag'; d.innerText='D'; d.style="position:absolute; bottom:-5px; right:-5px; width:18px; height:18px; background:white; color:black; border-radius:50%; font-size:10px; display:flex; align-items:center; justify-content:center;"; el.querySelector('.avatar').appendChild(d); }
                sIdx++;
            }
        }
    });
}

// 事件、动画、账本等其余代码...
socket.on('deal_cards', () => { setTimeout(() => { const pEls = document.querySelectorAll('.occupied, .my-area'); pEls.forEach((p, i) => { const rect = p.querySelector('.avatar, .my-avatar').getBoundingClientRect(); for (let j=0; j<2; j++) { setTimeout(() => { const c = document.createElement('div'); c.className = 'card anim-card'; c.innerHTML = '<div class="card-inner"><div class="card-back"></div></div>'; c.style.top = rect.top + 'px'; c.style.left = rect.left + 'px'; document.body.appendChild(c); setTimeout(() => c.remove(), 700); }, (i*200)+(j*100)); } }); }, 100); });
function animateChips(fromEl) { const chip = document.createElement('div'); chip.className = 'anim-chip'; const av = fromEl.querySelector('.avatar, .my-avatar'); if (!av) return; const rect = av.getBoundingClientRect(); chip.style.top = rect.top + 'px'; chip.style.left = rect.left + 'px'; document.body.appendChild(chip); setTimeout(() => chip.remove(), 500); }
function enableActionBtns(on) { [btnF, btnC, btnR].forEach(b => { if (on) b.classList.add('active'); else b.classList.remove('active'); }); }
btnLedger.onclick = () => { renderLedger(currentLedger); ledgerOverlay.style.display = 'flex'; };
ledgerClose.onclick = () => { ledgerOverlay.style.display = 'none'; };
socket.on('room_stats', (s) => { if (s.ledger) currentLedger = s.ledger; if (s.isGaming || s.playerCount > 0) { watchBtn.style.display = 'block'; watchBtn.innerText = `观看正在进行的 ${s.playerCount} 人比赛`; } else watchBtn.style.display = 'none'; });
socket.on('game_result', (res) => { if (res.ledger) currentLedger = res.ledger; resCards.innerHTML = ''; resOverlay.style.display = 'flex'; res.details.forEach(item => { const row = document.createElement('div'); row.style = "background: rgba(255,255,255,0.1); padding: 15px; border-radius: 12px; border-left: 4px solid var(--gold);"; row.innerHTML = `<div style="display:flex; justify-content:space-between;"><b>${item.name}</b><span style="color:var(--gold)">+¥${item.amount}</span></div><div style="font-size:11px; color:#888;">${item.hand}</div>`; resCards.appendChild(row); }); setTimeout(() => { resOverlay.style.display = 'none'; }, 4500); });
function renderLedger(d) { ledgerList.innerHTML = d.length ? '' : '<div style="text-align:center; color:#666; margin-top:50px;">暂无记录</div>'; d.forEach(item => { const row = document.createElement('div'); row.style="background:#1c1c1e; padding:15px; border-radius:12px; display:flex; justify-content:space-between; align-items:center;"; row.innerHTML = `<div><div style="font-size:11px; color:#666;">${item.time}</div><div style="font-weight:600;">${item.winners}</div><div style="font-size:11px; color:var(--gold);">${item.handType}</div></div><div style="font-size:18px; font-weight:800; color:var(--gold);">+¥${item.totalWin}</div>`; ledgerList.appendChild(row); }); }
btnR.onclick = () => { if (!lastState) return; const minNeeded = lastState.currentBet + lastState.minRaise; minRaiseHint.innerText = `最小加注到: ¥${minNeeded}`; raiseInput.value = minNeeded; raiseModal.style.display = 'flex'; raiseInput.focus(); };
window.setRaiseRate = (rate) => { if (!lastState) return; const totalPot = lastState.pots.reduce((sum, p) => sum + p.amount, 0); const amt = Math.floor(totalPot * rate); const minNeeded = lastState.currentBet + lastState.minRaise; raiseInput.value = Math.max(amt, minNeeded); };
window.setRaiseAllIn = () => { const me = lastState.players.find(p => p.id === myId || p.name === localStorage.getItem('poker_nick')); if (me) raiseInput.value = me.chips + (me.currentBet || 0); };
window.closeRaiseModal = () => { raiseModal.style.display = 'none'; };
window.confirmRaise = () => { const amt = parseInt(raiseInput.value); const minNeeded = lastState.currentBet + lastState.minRaise; if (isNaN(amt) || amt < minNeeded) { alert("加注金额不足"); return; } socket.emit('player_action', { type: 'raise', amount: amt }); closeRaiseModal(); animateChips(meArea); };
