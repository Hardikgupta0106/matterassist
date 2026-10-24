# ---------- Stage 1: build the React client ----------
FROM node:20-slim AS client-build
WORKDIR /client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# ---------- Stage 2: everything in one container (MongoDB + ai-service + server + nginx) ----------
FROM mongo:7

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv build-essential \
      nginx supervisor curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# non-root user (Hugging Face Spaces runs containers as uid 1000)
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user
WORKDIR /home/user

# data folders (mongo + chroma)
RUN mkdir -p /home/user/data/db /home/user/data/chroma /home/user/www

# ---- ai-service (python) ----
COPY --chown=user ai-service/requirements.txt /home/user/ai-service/requirements.txt
RUN python3 -m venv /home/user/venv \
    && /home/user/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /home/user/venv/bin/pip install --no-cache-dir -r /home/user/ai-service/requirements.txt
COPY --chown=user ai-service/ /home/user/ai-service/

# ---- server (node) ----
COPY --chown=user server/package*.json /home/user/server/
RUN cd /home/user/server && npm install --omit=dev
COPY --chown=user server/ /home/user/server/

# ---- client build + configs ----
COPY --chown=user --from=client-build /client/dist/ /home/user/www/
COPY --chown=user deploy/nginx.conf /home/user/nginx.conf
COPY --chown=user deploy/supervisord.conf /home/user/supervisord.conf

ENV CHROMA_DIR=/home/user/data/chroma
EXPOSE 7860

ENTRYPOINT []
CMD ["supervisord", "-c", "/home/user/supervisord.conf"]