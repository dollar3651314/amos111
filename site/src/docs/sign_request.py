import hashlib, hmac, json, os, time, uuid, requests

BASE = os.environ.get("QC_BASE_URL", "https://{BASE_URL}")
KEY, SECRET = os.environ["QC_KEY"], os.environ["QC_SECRET"].encode()

def qc(method, path, body=None):
    ts = str(int(time.time()))
    raw = json.dumps(body, separators=(",", ":")) if body else ""
    body_hash = hashlib.sha256(raw.encode()).hexdigest()
    to_sign = "\n".join([ts, method, "/api/v1/" + path, body_hash])
    sig = hmac.new(SECRET, to_sign.encode(), hashlib.sha256).hexdigest()
    headers = {"content-type": "application/json", "X-QC-Key": KEY,
               "X-QC-Timestamp": ts, "X-QC-Signature": sig}
    if method == "POST":
        headers["Idempotency-Key"] = str(uuid.uuid4())
    return requests.request(method, BASE + "/api/v1/" + path, data=raw or None, headers=headers).json()

print(qc("GET", "balance/"))
