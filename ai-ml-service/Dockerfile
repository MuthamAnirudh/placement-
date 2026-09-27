FROM python:3.14-slim

WORKDIR /app

# NOTE (Render free tier): libgl1/libglib2.0-0 were only needed for opencv-python,
# which is now omitted from requirements.txt to fit in 512MB RAM (see that file's
# comments). ffmpeg is still needed for audio-prosody decoding. build-essential is
# kept for any package that needs to compile from source on install.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Render (and most PaaS hosts) inject a PORT env var and expect the container to
# bind to it — it is NOT always 8000. Falls back to 8000 for local `docker run`.
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
