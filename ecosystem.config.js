module.exports = {
  apps: [
    { name: "server", script: "server.js", env: { PORT: 8000 } },
    { name: "bot-js", script: "Bot.js",    env: { PORT: 3002 } },
    { name: "tts",    script: "tts.js",    env: { PORT: 3001 } },
    { name: "bot-py", script: "Bot.py",    interpreter: "python3", env: { PORT: 10000 } }
  ]
}
