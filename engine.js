const { Hand } = require('pokersolver');

const Engine = {
    calculatePots: (players) => {
        const activePlayers = players.filter(p => p.status !== 'idle');
        const contributions = activePlayers.map(p => ({ 
            id: p.id, 
            amount: p.totalHandInvestment || 0, 
            eligible: p.status === 'active' || p.status === 'all-in' 
        }));
        const levels = [...new Set(contributions.map(c => c.amount))].sort((a,b) => a-b);
        let pots = [];
        let prevLevel = 0;
        for (let level of levels) {
            let potAmt = 0;
            let eligibleIds = [];
            for (let c of contributions) {
                if (c.amount >= level) { potAmt += (level - prevLevel); if (c.eligible) eligibleIds.push(c.id); }
                else if (c.amount > prevLevel) { potAmt += (c.amount - prevLevel); }
            }
            if (potAmt > 0 && eligibleIds.length > 0) pots.push({ amount: potAmt, eligiblePlayers: eligibleIds });
            prevLevel = level;
        }
        return pots;
    },

    toSolver: (c) => {
        if (!c || c === '?') return null;
        const v = c.value === '10' ? 'T' : c.value;
        const s = { '♥': 'h', '♠': 's', '♦': 'd', '♣': 'c' }[c.suit];
        return v + s;
    },

    determineWinners: (pots, players, communityCards) => {
        let results = [];
        const community = communityCards.map(Engine.toSolver);

        pots.forEach((pot) => {
            const eligible = players.filter(p => pot.eligiblePlayers.includes(p.id));
            if (eligible.length === 0) return;

            // 建立临时映射：solverHand -> player
            const handToPlayer = new Map();
            const solverHands = eligible.map(p => {
                const playerCards = p.hand.map(Engine.toSolver);
                const hand = Hand.solve([...playerCards, ...community]);
                handToPlayer.set(hand, p); // 关键修复：直接建立对象映射
                return hand;
            });

            const winners = Hand.winners(solverHands);
            const winAmt = Math.floor(pot.amount / winners.length);

            winners.forEach(w => {
                const player = handToPlayer.get(w);
                if (player) {
                    results.push({ id: player.id, name: player.name, amount: winAmt, handName: w.name });
                }
            });
        });
        return results;
    }
};

module.exports = Engine;
