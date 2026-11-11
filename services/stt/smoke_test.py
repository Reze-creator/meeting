"""调用真实 STT；输入由 Windows 本地合成语音生成，完全不采集麦克风。"""
import argparse
import json
from pathlib import Path
from urllib.request import Request, urlopen
from uuid import uuid4

parser = argparse.ArgumentParser()
parser.add_argument("--url", default="http://127.0.0.1:8091/v1")
parser.add_argument("--wav", required=True)
parser.add_argument("--language", choices=["zh", "en"], default="zh")
args = parser.parse_args()
boundary = uuid4().hex
data = Path(args.wav).read_bytes()
body = (
    f'--{boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n{args.language}\r\n'
    f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.wav"\r\n'
    'Content-Type: audio/wav\r\n\r\n'
).encode() + data + f"\r\n--{boundary}--\r\n".encode()
request = Request(args.url.rstrip("/") + "/audio/transcriptions", data=body,
                  headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
with urlopen(request, timeout=60) as response:
    result = json.load(response)
if not result.get("text", "").strip():
    raise RuntimeError("真实 STT 没有返回转写")
print("真实 STT 通过：", result["text"])
