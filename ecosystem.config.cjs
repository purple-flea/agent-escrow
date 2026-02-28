module.exports = {
  apps: [{
    name: "escrow",
    script: "dist/index.js",
    cwd: "/home/dev/escrow",
    env: {
      PORT: "3007",
      CASINO_DB_PATH: "/home/dev/casino/data/casino.db",
    }
  }]
};
