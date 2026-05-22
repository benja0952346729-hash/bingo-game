FROM node:18-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages \
    pyTelegramBotAPI flask requests

RUN npm install -g pm2

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 8000

CMD ["sh", "-c", "node server.js & PORT=3002 node Bot.js & PORT=3001 node tts.js & python3 Bot.py & wait"]
