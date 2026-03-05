const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'poker.db'));

// 初始化表结构
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT UNIQUE,
    chips INTEGER DEFAULT 1000
  );

  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT,
    winners TEXT,
    total_win INTEGER,
    hand_type TEXT
  );
`);

const DB = {
    // 获取或创建用户并返回筹码
    getUserChips: (nickname) => {
        const row = db.prepare('SELECT chips FROM users WHERE nickname = ?').get(nickname);
        if (row) return row.chips;
        
        // 如果是新用户，插入默认筹码
        db.prepare('INSERT INTO users (nickname, chips) VALUES (?, 1000)').run(nickname);
        return 1000;
    },

    // 更新用户筹码
    updateUserChips: (nickname, chips) => {
        db.prepare('UPDATE users SET chips = ? WHERE nickname = ?').run(chips, nickname);
    },

    // 记录对局明细
    addLedgerEntry: (winners, totalWin, handType) => {
        const time = new Date().toLocaleString('zh-CN', { hour12: false });
        db.prepare('INSERT INTO ledger (time, winners, total_win, hand_type) VALUES (?, ?, ?, ?)')
          .run(time, winners, totalWin, handType);
    },

    // 获取最近的账本记录
    getRecentLedger: (limit = 50) => {
        return db.prepare('SELECT time, winners, total_win as totalWin, hand_type as handType FROM ledger ORDER BY id DESC LIMIT ?').all(limit);
    }
};

module.exports = DB;
