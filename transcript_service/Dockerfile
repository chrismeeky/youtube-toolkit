FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Hugging Face Spaces runs the container as uid 1000 and expects a writable HOME.
RUN useradd --create-home --uid 1000 user
ENV HOME=/home/user

WORKDIR /app

COPY requirements.txt .
RUN pip install --requirement requirements.txt

COPY app.py .

USER user

# Overridden by $PORT on Render and Koyeb; Spaces expects 7860.
ENV HOST=0.0.0.0 \
    PORT=7860
EXPOSE 7860

CMD ["python", "app.py"]
