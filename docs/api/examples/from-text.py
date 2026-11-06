"""NLO H1 text-to-notebook — compact sync client (requests, zero other deps).

Self-contained. Run against a REAL running instance (mock or live provider):

    python docs/api/examples/from-text.py [baseUrl]
    NLO_API_TOKEN=nlo_... python docs/api/examples/from-text.py http://127.0.0.1:4871

The token is optional in the default (loopback, optional-auth) mode and
required when the server runs with NLO_API_AUTH=true.

The default run is a safe no-op: it exercises only validation (400s) and a
404 poll — **no job is created and no provider is touched**. Pass `--submit`
to actually create a text job (a real job will run).
"""

import os
import sys
import time

import requests

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4871").rstrip("/")
V1 = f"{BASE}/api/v1"
TOKEN = os.environ.get("NLO_API_TOKEN") or None
H = {"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}

TEXT = (
    "بررسی بودجه و برنامه‌ی اجرایی سه‌ماهه‌ی اول؛ نتیجه: تصویب با دو اصلاح."
)


def submit_text_job():
    r = requests.post(
        f"{V1}/notebooks/from-text",
        headers={**H, "Content-Type": "application/json", "Idempotency-Key": "memo-example"},
        json={
            "title": "جلسه ۱۴۰۴/۰۸/۰۱",
            "text": TEXT,
            "metadata": {"language": "fa"},
            "summary": {"enabled": True},  # omit "prompt" => default master prompt v1
        },
        timeout=30,
    )
    print("submit:", r.status_code, r.json())
    return r.json()["jobId"]


def poll_result(job_id, timeout_s=600):
    terminal = {"SUCCEEDED", "FAILED", "CANCELLED", "NEEDS_ATTENTION"}
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        r = requests.get(f"{V1}/jobs/{job_id}/result", headers=H, timeout=30)
        res = r.json()
        if res.get("status") in terminal:
            print("result:", r.status_code, res)
            return res
        print("poll:", res.get("status"))
        time.sleep(3)
    raise TimeoutError(f"job {job_id} not terminal within {timeout_s}s")


def main():
    health = requests.get(f"{BASE}/api/health", timeout=10).json()
    print("health:", health)

    if "--submit" in sys.argv:
        job_id = submit_text_job()  # 202 {"jobId": "j_...", "status": "CREATED", ...}
        poll_result(job_id)
    else:
        # Safe validation-only flow: no job is created, no provider is touched.
        for name, payload in [
            ("empty text", {"text": ""}),
            ("whitespace-only text", {"text": "   "}),
            ("body without text", {}),
        ]:
            r = requests.post(
                f"{V1}/notebooks/from-text",
                headers={**H, "Content-Type": "application/json"},
                json=payload,
                timeout=30,
            )
            print(f"validation ({name}):", r.status_code, r.json())

        # Polling shape against an unknown job -> 404 not_found
        r = requests.get(f"{V1}/jobs/j_00000000000000000000000000000000/result", headers=H, timeout=30)
        print("poll unknown job:", r.status_code, r.json())


if __name__ == "__main__":
    main()
