#!/usr/bin/env python3
"""NotebookLM Orchestrator — Python worker for notebooklm-py.

JSON-line protocol (one JSON object per line, LF-terminated):

  request : {"id": <int>, "op": <str>, "params": {...}}
  response: {"id": <int>, "ok": true,  "result": {...}}
            {"id": <int>, "ok": false, "error": {"code": <str>, "message": <str>}}
  event   : {"event": "progress"|"log", "op": <int|null>, "data": {...}}

Ops:
  ping            -> {"version", "notebooklmPy", "playwright": bool}
  validate        {sessionPath} -> {ok, exists, email?}
  verify          {sessionPath, timeoutSec} -> {email, notebooks, checkedAt}
  login           {sessionPath, headless, browser, timeoutSec} -> {email}
                  (interactive: a browser window is opened for the user)
  job             {sessionPath, audioPath, audioName, prompt,
                   notebookTitle, waitSec, timeoutSec}
                  -> {email, notebookId, notebookTitle, sourceId,
                      uploaded, conversationId, turnNumber, answer,
                      references, checkedAt}

Security notes:
  * The worker is spawned per job with NO shell.
  * Session files are read directly from the app's private storage (0600).
  * Nothing sensitive is printed; progress events carry only counters/ids.
  * Proxy routing (when required) is done via HTTPS_PROXY/HTTP_PROXY/
    ALL_PROXY env vars set by the supervisor BEFORE spawn — the notebooklm-py
    web client honors them (default trust_env). See docs/architecture/proxy-design.md.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Output plumbing: a single global write lock so JSON lines never interleave.
# ---------------------------------------------------------------------------
_write_lock = asyncio.Lock()


async def emit(obj: dict[str, Any]) -> None:
    line = json.dumps(obj, ensure_ascii=False)
    async with _write_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Error mapping: notebooklm-py exceptions -> stable error codes.
# ---------------------------------------------------------------------------
def _classify(exc: BaseException) -> tuple[str, str]:
    try:
        from notebooklm.exceptions import (
            AuthError,
            AuthExtractionError,
            ConfigurationError,
            HeadlessLoginRequiredError,
            MissingDependencyError,
            NetworkError,
            NotFoundError,
            NonIdempotentRetryError,
            RateLimitError,
            ServerError,
            ValidationError,
            WaitTimeoutError,
        )
    except ImportError:  # notebooklm-py not importable
        return "provider_unavailable", f"notebooklm-py import failed: {exc}"

    def code(name: str, msg: str) -> tuple[str, str]:
        return name, msg

    if isinstance(exc, (AuthError, AuthExtractionError, HeadlessLoginRequiredError)):
        return code("auth", str(exc))
    if isinstance(exc, RateLimitError):
        return code("rate_limit", str(exc))
    if isinstance(exc, WaitTimeoutError):
        return code("timeout", str(exc))
    if isinstance(exc, NetworkError):
        return code("connectivity", str(exc))
    if isinstance(exc, ValidationError):
        return code("invalid_input", str(exc))
    if isinstance(exc, NotFoundError):
        return code("not_found", str(exc))
    if isinstance(exc, NonIdempotentRetryError):
        return code("ambiguous", str(exc))
    if isinstance(exc, MissingDependencyError):
        return code("provider_unavailable", str(exc))
    if isinstance(exc, ConfigurationError):
        return code("configuration", str(exc))
    if isinstance(exc, ServerError):
        return code("provider", str(exc))
    return "unknown", f"{type(exc).__name__}: {exc}"


# ---------------------------------------------------------------------------
# Ops
# ---------------------------------------------------------------------------
async def op_ping(_p: dict[str, Any]) -> dict[str, Any]:
    import importlib.metadata as md

    version = None
    try:
        version = md.version("notebooklm-py")
    except md.PackageNotFoundError:
        version = None
    has_playwright = None
    try:
        import playwright  # noqa: F401

        has_playwright = True
    except ImportError:
        has_playwright = False
    return {"version": version, "playwright": has_playwright}


def _secure_write(path: Path, data: bytes) -> None:
    """Atomic write with 0600 permissions."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-session-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


async def _client_with(path: Path, timeout_sec: float):
    from notebooklm import NotebookLMClient

    ctx = NotebookLMClient.from_storage(path=str(path), timeout=float(timeout_sec))
    client = await ctx.__aenter__()
    return ctx, client


async def op_validate(p: dict[str, Any]) -> dict[str, Any]:
    session = Path(p["sessionPath"])
    out: dict[str, Any] = {"ok": False, "exists": session.exists(), "email": None}
    if not out["exists"]:
        return out
    ctx, client = await _client_with(session, 30.0)
    try:
        email = await client.get_account_email(live_fallback=False)
        out["email"] = email
        out["ok"] = bool(email)
    finally:
        await ctx.__aexit__(None, None, None)
    return out


async def op_verify(p: dict[str, Any]) -> dict[str, Any]:
    session = Path(p["sessionPath"])
    timeout = float(p.get("timeoutSec", 60))
    ctx, client = await _client_with(session, timeout)
    try:
        email = await client.get_account_email(live_fallback=True)
        notebooks = await client.notebooks.list()
        return {
            "email": email,
            "notebooks": len(notebooks),
            "checkedAt": now_iso(),
        }
    finally:
        await ctx.__aexit__(None, None, None)


async def op_login(p: dict[str, Any]) -> dict[str, Any]:
    session = Path(p["sessionPath"])
    headless = bool(p.get("headless", False))
    browser = p.get("browser", "chromium")
    timeout = int(p.get("timeoutSec", 600))
    # Browser-level proxy (Playwright launch option). Chromium does NOT honor
    # HTTPS_PROXY/HTTP_PROXY env vars for its own traffic, so when a tunnel is
    # required the supervisor passes {"server": "http://127.0.0.1:PORT", ...}.
    proxy = p.get("proxy") or None

    from playwright.async_api import async_playwright

    async def _progress(stage: str) -> None:
        await emit({"event": "log", "op": None, "data": {"stage": stage}})

    async with async_playwright() as pw:
        launch_kwargs: dict[str, Any] = {"headless": headless}
        if browser != "chromium":
            launch_kwargs["channel"] = browser
        if proxy:
            launch_kwargs["proxy"] = proxy
        await _progress("launching_browser")
        browser_obj = await pw.chromium.launch(**launch_kwargs)
        try:
            context = await browser_obj.new_context()
            page = await context.new_page()
            await _progress("waiting_for_signin")
            await page.goto(
                "https://notebooklm.google.com/", wait_until="domcontentloaded"
            )
            deadline = asyncio.get_running_loop().time() + timeout
            signed_in = False
            while asyncio.get_running_loop().time() < deadline:
                url = page.url
                if "/notebooks" in url:
                    signed_in = True
                    break
                # Also accept presence of a notebooklm auth cookie.
                cookies = await context.cookies("https://notebooklm.google.com")
                if any(
                    c.get("name") == "__Secure-1PSID" or c.get("name") == "SID"
                    for c in cookies
                ):
                    # Give the app a moment to settle on the notebooks page.
                    try:
                        await page.wait_for_url("**/notebooks**", timeout=20000)
                        signed_in = True
                        break
                    except Exception:
                        pass
                await page.wait_for_timeout(1500)
            if not signed_in:
                raise TimeoutError("browser sign-in did not complete within timeout")
            state = await context.storage_state()
            await _progress("saving_session")
            _secure_write(
                session, json.dumps(state, ensure_ascii=False).encode("utf-8")
            )
        finally:
            await browser_obj.close()

    # Verify the freshly saved session against the real service.
    verified = await op_verify({"sessionPath": str(session), "timeoutSec": 60})
    return {"email": verified.get("email")}


# Browsers the UI may select for cookie import. This is an allowlist of
# names the installed notebooklm-py CLI understands for --browser-cookies;
# the value is never executed — it is one argument to the CLI. Chromium-
# family profiles use the documented "name::Profile" selector syntax.
BROWSER_COOKIE_NAMES = frozenset(
    {
        "auto",
        "chrome",
        "firefox",
        "chromium",
        "brave",
        "edge",
        "opera",
        "vivaldi",
        "librewolf",
        "zen",
        "cachy",
    }
)


def _validate_browser_spec(browser: str) -> str:
    base = browser.split("::", 1)[0].strip().lower()
    if base not in BROWSER_COOKIE_NAMES:
        raise ValueError(
            f"browser not allowed for cookie import: {browser!r} "
            f"(allowed: {', '.join(sorted(BROWSER_COOKIE_NAMES))})"
        )
    if len(browser) > 80:
        raise ValueError("browser spec too long")
    return browser


async def op_browser_import(p: dict[str, Any]) -> dict[str, Any]:
    """Import Google cookies from an installed, non-automated browser.

    This bypasses the Playwright-driven sign-in that Google's bot detection
    rejects ("browser or app may not be secure") by reading the cookie jar of
    the user's REAL browser via the installed notebooklm-py CLI
    (`notebooklm login --browser-cookies`), writing the session straight to
    our 0600 storage-state path. The CLI's built-in verification step runs
    through the tunnel (HTTPS_PROXY env), and we re-verify against the real
    service ourselves before reporting success.
    """
    session = Path(p["sessionPath"])
    browser = _validate_browser_spec(str(p.get("browser", "chrome")))
    account = p.get("account") or None
    timeout = int(p.get("timeoutSec", 180))

    argv = [
        sys.executable,
        "-m",
        "notebooklm",
        "login",
        "--storage",
        str(session),
        "--browser-cookies",
        browser,
    ]
    if account:
        argv += ["--account", str(account)[:200]]

    # The CLI must not see any NOTEBOOKLM_* auth env vars (the env-var auth
    # fast path would bypass the cookie import and we would misattribute a
    # session). Proxy vars are kept so the CLI's verification step routes
    # through the tunnel exactly like every other service call.
    env = {k: v for k, v in os.environ.items() if not k.startswith("NOTEBOOKLM_")}

    await emit(
        {"event": "log", "op": None, "data": {"stage": "importing_browser_cookies"}}
    )
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            # Non-interactive: the CLI must never inherit the worker's stdin
            # (which is a live protocol pipe being drained by our reader
            # thread). DEVNULL gives EOF if anything probes stdin.
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"browser cookie import failed to start: {exc}")

    # Stream stderr in real time (the CLI prints progress there) and buffer
    # stdout, to surface exactly where a hang occurs.
    stderr_lines: list[str] = []
    stdout_chunks: list[bytes] = []

    async def _drain_stderr() -> None:
        assert proc.stderr is not None
        while True:
            raw = await proc.stderr.readline()
            if not raw:
                break
            line = raw.decode("utf-8", "replace").rstrip()
            if line:
                stderr_lines.append(line)
                await emit(
                    {"event": "log", "op": None, "data": {"stage": "cli_stderr", "line": line[:500]}}
                )

    async def _drain_stdout() -> None:
        assert proc.stdout is not None
        while True:
            raw = await proc.stdout.read(65536)
            if not raw:
                break
            stdout_chunks.append(raw)

    try:
        async with asyncio.timeout(timeout):
            await asyncio.gather(_drain_stderr(), _drain_stdout())
            await proc.wait()
    except TimeoutError:
        proc.kill()
        await proc.wait()
        tail = " | ".join(stderr_lines[-10:])
        raise RuntimeError(
            f"browser cookie import timed out after {timeout}s. last stderr: {tail[-1200:]}"
        )

    tail = (
        b"".join(stdout_chunks).decode("utf-8", "replace")
        + "\n"
        + "\n".join(stderr_lines)
    ).strip()[-1500:]
    if proc.returncode != 0:
        raise RuntimeError(
            f"browser cookie import failed (exit {proc.returncode}): {tail}"
        )
    if not session.exists():
        raise RuntimeError(
            f"browser cookie import reported success but wrote no session: {tail}"
        )

    os.chmod(session, 0o600)

    # Never trust the exit code: verify against the REAL service.
    await emit({"event": "log", "op": None, "data": {"stage": "verifying_session"}})
    verified = await op_verify({"sessionPath": str(session), "timeoutSec": 60})
    return {"email": verified.get("email"), "notebooks": verified.get("notebooks")}


async def op_job(p: dict[str, Any]) -> dict[str, Any]:
    session = Path(p["sessionPath"])
    audio_path = Path(p["audioPath"])
    audio_name = p.get("audioName") or audio_path.name
    prompt = str(p["prompt"])
    notebook_title = str(p["notebookTitle"])
    wait_sec = float(p.get("waitSec", 600))
    timeout_sec = float(p.get("timeoutSec", 1800))

    async def _progress(stage: str, **data: Any) -> None:
        await emit({"event": "progress", "op": None, "data": {"stage": stage, **data}})

    if not str(audio_path).strip() or not audio_path.is_file():
        raise FileNotFoundError(f"audio file not found: {audio_path}")

    await _progress("opening_session")
    ctx, client = await _client_with(session, min(timeout_sec, 300))
    try:
        email = await client.get_account_email(live_fallback=True)
        await _progress("selecting_notebook")
        notebooks = await client.notebooks.list()
        nb = next(
            (n for n in notebooks if getattr(n, "title", None) == notebook_title), None
        )
        if nb is None:
            nb = await client.notebooks.create(title=notebook_title)
            await _progress(
                "notebook_created", notebookId=getattr(nb, "notebook_id", None)
            )
        notebook_id = getattr(nb, "notebook_id", None) or getattr(nb, "id", None)

        # NOTE: notebooklm-py's Source model identifies a source via `.id`
        # (older builds used `.source_id`), so every read falls back to `.id`.
        # A missing id here would otherwise surface as "Source not found: None"
        # from wait_until_ready.
        def _src_id(s: Any) -> str | None:
            return getattr(s, "source_id", None) or getattr(s, "id", None)

        # Idempotency anchor: reuse an existing source with the same title
        # instead of double-uploading on a safe retry.
        uploaded = True
        source = None
        try:
            sources = await client.sources.list(notebook_id)
            source = next(
                (s for s in sources if getattr(s, "title", None) == audio_name), None
            )
        except Exception:
            source = None
        if source is not None:
            uploaded = False
            await _progress("source_reused", sourceId=_src_id(source))
        else:
            await _progress("uploading_audio")
            source = await client.sources.add_file(
                notebook_id,
                audio_path,
                title=audio_name,
            )
            await _progress("upload_done", sourceId=_src_id(source))

        source_id = _src_id(source)
        if not source_id:
            raise RuntimeError(
                "audio upload reported success but returned no source id "
                f"(source={type(source).__name__}); cannot wait for processing"
            )
        await _progress("waiting_for_processing")
        await client.sources.wait_until_ready(notebook_id, source_id, timeout=wait_sec)
        await _progress("processing_done")

        await _progress("executing_prompt")
        result = await client.chat.ask(notebook_id, prompt, source_ids=[source_id])
        await _progress("prompt_done")

        refs = []
        for r in getattr(result, "references", None) or []:
            refs.append(
                {
                    "sourceId": getattr(r, "source_id", None),
                    "quote": getattr(r, "quote", None),
                }
            )

        return {
            "email": email,
            "notebookId": notebook_id,
            "notebookTitle": notebook_title,
            "sourceId": source_id,
            "uploaded": uploaded,
            "conversationId": getattr(result, "conversation_id", None),
            "turnNumber": getattr(result, "turn_number", None),
            "answer": getattr(result, "answer", "") or "",
            "references": refs,
            "checkedAt": now_iso(),
        }
    finally:
        await ctx.__aexit__(None, None, None)


OPS = {
    "ping": op_ping,
    "validate": op_validate,
    "verify": op_verify,
    "login": op_login,
    "browser-import": op_browser_import,
    "job": op_job,
}


async def main() -> None:
    loop = asyncio.get_running_loop()
    stop = loop.create_future()

    def _stop_once() -> None:
        if not stop.done():
            stop.set_result(None)

    # Prefer the event loop's own signal plumbing: its C-level handler only
    # writes to a self-pipe, so the callback runs as normal loop processing.
    # On some Linux hosts a Python-level signal.signal() callback is NOT
    # delivered while an asyncio loop is running (observed on s52, 2026-10-25),
    # which left the worker unresponsive to SIGTERM. Windows'
    # ProactorEventLoop has no add_signal_handler, so fall back there.
    for _sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(_sig, _stop_once)
        except (NotImplementedError, RuntimeError, ValueError):
            signal.signal(_sig, lambda _s, _f: _stop_once())

    # NOTE (Windows): the ProactorEventLoop cannot use overlapped I/O on pipe
    # handles on this machine (CreateIoCompletionPort rejects pipe handles
    # with ERROR_INVALID_HANDLE, while socket handles work). Reading stdin via
    # the loop's pipe transport therefore crashes at startup. Instead, a
    # dedicated blocking thread reads lines from stdin and forwards them to
    # the event loop thread-safely — same protocol, no IOCP dependency.
    queue: asyncio.Queue[bytes | None] = asyncio.Queue()

    def _stdin_reader() -> None:
        try:
            while True:
                raw = sys.stdin.buffer.readline()
                if not raw:
                    break
                loop.call_soon_threadsafe(queue.put_nowait, raw)
        except Exception:  # noqa: BLE001 - stdin gone; EOF below
            pass
        loop.call_soon_threadsafe(queue.put_nowait, None)
        # Stdin EOF is the supervisor's signal-free shutdown path: it must
        # end the process even when no SIGTERM was ever delivered/honored.
        loop.call_soon_threadsafe(_stop_once)

    threading.Thread(target=_stdin_reader, name="nlo-stdin", daemon=True).start()

    async def feed() -> None:
        while True:
            line = await queue.get()
            if line is None:
                break
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line.decode("utf-8"))
            except json.JSONDecodeError as e:
                await emit(
                    {
                        "id": None,
                        "ok": False,
                        "error": {"code": "protocol", "message": f"bad json: {e}"},
                    }
                )
                continue
            rid = req.get("id")
            op = req.get("op")
            params = req.get("params") or {}
            handler = OPS.get(op)
            if handler is None:
                await emit(
                    {
                        "id": rid,
                        "ok": False,
                        "error": {"code": "protocol", "message": f"unknown op: {op}"},
                    }
                )
                continue
            try:
                result = await handler(params)
                await emit({"id": rid, "ok": True, "result": result})
            except Exception as exc:  # noqa: BLE001 - boundary: classify everything
                code, message = _classify(exc)
                await emit(
                    {
                        "id": rid,
                        "ok": False,
                        "error": {"code": code, "message": message[:2000]},
                    }
                )

    feed_task = asyncio.create_task(feed())
    stop_task = asyncio.ensure_future(stop)
    # Wait for EITHER the stop signal OR stdin EOF (feed_task finishing).
    # Awaiting the stop future alone meant a worker whose stdin was already
    # closed — or whose SIGTERM never fired — never exited.
    await asyncio.wait({stop_task, feed_task}, return_when=asyncio.FIRST_COMPLETED)
    # The supervisor sends SIGTERM (or closes stdin) to terminate the worker,
    # e.g. on request timeout. A running op (notebooklm-py calls, waits) must
    # NOT outlive the process: cancel it so asyncio.run can finish and the
    # interpreter can exit. Without this, a worker keeps its in-flight op
    # alive until the child is force-killed, and the NotebookLM-side
    # operation may complete after the job was already finalized (orphaned
    # server-side work).
    if not feed_task.done():
        feed_task.cancel()
    if not stop_task.done():
        stop_task.cancel()
    await asyncio.gather(feed_task, stop_task, return_exceptions=True)


if __name__ == "__main__":
    asyncio.run(main())
