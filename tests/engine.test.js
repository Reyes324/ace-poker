const { expect } = require('chai');
const Engine = require('../engine');

describe('ACE Poker Engine - 核心逻辑测试', () => {

    describe('边池计算 (calculatePots)', () => {
        it('应当在三方全押且筹码不等时正确拆分主池和边池', () => {
            const players = [
                { id: 'A', status: 'all-in', totalHandInvestment: 100 },
                { id: 'B', status: 'all-in', totalHandInvestment: 500 },
                { id: 'C', status: 'active', totalHandInvestment: 500 }
            ];

            const pots = Engine.calculatePots(players);

            // 预期：
            // 主池：100 * 3 = 300 (A, B, C 均有权)
            // 边池 1：(500 - 100) * 2 = 800 (只有 B, C 有权)
            expect(pots).to.have.lengthOf(2);
            expect(pots[0].amount).to.equal(300);
            expect(pots[0].eligiblePlayers).to.include.members(['A', 'B', 'C']);
            expect(pots[1].amount).to.equal(800);
            expect(pots[1].eligiblePlayers).to.not.include('A');
            expect(pots[1].eligiblePlayers).to.include.members(['B', 'C']);
        });
    });

    describe('牌型判定 (determineWinners)', () => {
        it('应当在比牌阶段准确判定赢家（同花赢过三条）', () => {
            const communityCards = [
                { value: '2', suit: '♥' },
                { value: '5', suit: '♥' },
                { value: '9', suit: '♥' },
                { value: 'J', suit: '♠' },
                { value: 'K', suit: '♣' }
            ];

            const players = [
                { id: 'P1', name: 'Alice', hand: [{ value: 'A', suit: '♥' }, { value: 'Q', suit: '♥' }], status: 'active' }, // 同花
                { id: 'P2', name: 'Bob', hand: [{ value: '2', suit: '♠' }, { value: '2', suit: '♣' }], status: 'active' }    // 三条 2
            ];

            const pots = [{ amount: 1000, eligiblePlayers: ['P1', 'P2'] }];
            const results = Engine.determineWinners(pots, players, communityCards);

            expect(results).to.have.lengthOf(1);
            expect(results[0].name).to.equal('Alice');
            expect(results[0].handName).to.equal('Flush');
        });

        it('应当正确处理平局并平分底池', () => {
            const communityCards = [
                { value: 'A', suit: '♠' }, { value: 'K', suit: '♠' }, { value: 'Q', suit: '♠' },
                { value: 'J', suit: '♠' }, { value: '10', suit: '♠' }
            ]; // 皇家同花顺在公牌

            const players = [
                { id: 'P1', name: 'Alice', hand: [{ value: '2', suit: '♥' }, { value: '3', suit: '♥' }], status: 'active' },
                { id: 'P2', name: 'Bob', hand: [{ value: '4', suit: '♣' }, { value: '5', suit: '♣' }], status: 'active' }
            ];

            const pots = [{ amount: 100, eligiblePlayers: ['P1', 'P2'] }];
            const results = Engine.determineWinners(pots, players, communityCards);

            expect(results).to.have.lengthOf(2);
            expect(results[0].amount).to.equal(50);
            expect(results[1].amount).to.equal(50);
        });
    });
});
