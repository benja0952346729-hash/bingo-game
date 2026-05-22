FROM python:3.11-slim

# Node.js ጫን
RUN apt-get update && apt-get install -y nodejs npm

WORKDIR /app

# Python dependencies
COPY requirements.txt .
RUN pip install -r requirements.txt

# Node dependencies
COPY package.json .
RUN npm install

# ሁሉም files
COPY . .

EXPOSE 3000

# ሁለቱንም አብረው ጀምር
CMD python bot.py & node server.js & wait
