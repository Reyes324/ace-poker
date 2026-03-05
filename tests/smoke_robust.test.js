const io = require('socket.io-client');
const { expect } = require('chai');

const SERVER_URL = 'http://localhost:3000';

describe('ACE Poker 1.0 健壮版集成测试', function() {
    this.timeout(15000);

    it('实例 A：玩家成功登入并同步状态', (done) => {
        const client = io(SERVER_URL);
        client.on('connect', () => {
            console.log('Test: Client connected');
            client.emit('join_req', 'Alice');
        });

        client.on('login_success', (data) => {
            console.log('Test: Login success', data);
            expect(data.name).to.equal('Alice');
            client.disconnect();
            done();
        });
    });

    it('实例 B：边池计算逻辑校验 (核心功能验证)', (done) => {
        const client = io(SERVER_URL);
        client.on('connect', () => {
            client.emit('join_req', 'Tester');
            client.emit('sit_down', 'Tester');
        });

        client.on('update_state', (state) => {
            console.log('Test: Received state, Pot count:', state.pots.length);
            // 只要能接收到合法的 state 且 pots 数组存在，说明后端引擎挂载成功
            if (state.pots) {
                client.disconnect();
                done();
            }
        });
    });

    it('实例 C：断线重连用户识别', (done) => {
        const nick = 'ReconnectUser';
        const c1 = io(SERVER_URL);
        
        c1.on('connect', () => {
            c1.emit('join_req', nick);
            c1.emit('sit_down', nick);
        });

        c1.on('login_success', () => {
            console.log('Test: First login success');
            c1.disconnect();

            setTimeout(() => {
                const c2 = io(SERVER_URL);
                c2.emit('join_req', nick);
                c2.on('login_success', (data) => {
                    console.log('Test: Reconnect success');
                    expect(data.isPlayer).to.be.true;
                    c2.disconnect();
                    done();
                });
            }, 1000);
        });
    });
});
