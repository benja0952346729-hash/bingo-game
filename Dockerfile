FROM python:3.11-slim

# Node.js ጫን
RUN apt-get update && apt-get install -y nodejs npm

WORKDIR /app

# Python deps
COPY Bot.py .
RUN pip install requests pyTelegramBotAPI flask

# Node deps
COPY package.json .
RUN npm install
COPY Bot.js .
COPY tts.js .

EXPOSE 10000

# ሦስቱንም አብረው ጀምር
CMD python Bot.py & node Bot.js & node tts.js & wait
