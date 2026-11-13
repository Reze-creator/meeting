"""本地 Whisper STT：只监听回环地址，不保存原始音频，不记录转写正文。"""

from contextlib import asynccontextmanager
from io import BytesIO
import os
from threading import BoundedSemaphore
import wave
import numpy as np

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from faster_whisper import WhisperModel
from starlette.concurrency import run_in_threadpool

model: WhisperModel | None = None
inference_slot = BoundedSemaphore(1)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global model
    # CPU int8 无需 CUDA。模型在启动时加载，健康检查成功意味着已经可以识别。
    model = await run_in_threadpool(
        lambda: WhisperModel(
            os.getenv("WHISPER_MODEL", "tiny"),
            device="cpu",
            compute_type="int8",
            cpu_threads=max(1, int(os.getenv("WHISPER_THREADS", "4"))),
            download_root=os.getenv("WHISPER_CACHE", "data/whisper-models"),
        )
    )
    yield
    model = None


app = FastAPI(title="Comeet local STT", lifespan=lifespan)


@app.get("/health")
def health():
    return {"ready": model is not None}


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form("zh"),
    response_format: str = Form("json"),
    authorization: str | None = Header(None),
):
    expected = os.getenv("STT_SERVICE_KEY", "")
    if expected and authorization != f"Bearer {expected}":
        raise HTTPException(401, "Unauthorized")
    if language not in {"zh", "en"} or response_format != "json":
        raise HTTPException(400, "Unsupported language or format")
    data = await file.read((2 << 20) + 1)
    await file.close()
    if len(data) > 2 << 20:
        raise HTTPException(413, "Audio too large")
    try:
        with wave.open(BytesIO(data)) as wav:
            rate = wav.getframerate()
            duration = wav.getnframes() / rate
            if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or not 0.2 <= duration <= 8:
                raise ValueError("Invalid audio")
            # 直接解码已验证的 PCM WAV，避免依赖 PyAV 不同版本的容器参数。
            pcm = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768
            if rate != 16000:
                positions = np.arange(round(len(pcm) * 16000 / rate)) * (rate / 16000)
                pcm = np.interp(positions, np.arange(len(pcm)), pcm).astype(np.float32)
    except (wave.Error, EOFError, ValueError, ZeroDivisionError):
        raise HTTPException(400, "Expected mono PCM16 WAV, 0.2 to 8 seconds") from None
    # 不排无界队列。单个 CPU 模型忙时立即告知 Go，由页面展示处理速度不足。
    if not inference_slot.acquire(blocking=False):
        raise HTTPException(429, "STT busy")
    try:
        def recognize():
            assert model is not None
            segments, _ = model.transcribe(
                pcm, language=language, beam_size=1,
                vad_filter=True, condition_on_previous_text=False,
            )
            return "".join(segment.text for segment in segments).strip()

        return {"text": await run_in_threadpool(recognize)}
    finally:
        inference_slot.release()
