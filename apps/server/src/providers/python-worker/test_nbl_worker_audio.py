#!/usr/bin/env python3
"""Unit tests for the NLO-P2 audio ops in ``nbl_worker.py``.

Ops covered:
  * ``audio_generate``  — submit (or idempotently resume) an Audio Overview
  * ``audio_status``    — poll a generation task (task id == artifact id)
  * ``audio_download``  — fetch a completed artifact to a verified local file

Run (stdlib ``unittest`` only — the worker venv has no pytest):

    data\\venv\\Scripts\\python.exe -m unittest test_nbl_worker_audio -v
    (cwd: apps/server/src/providers/python-worker)

All tests run against a FAKE notebooklm-py client (provider boundary).
Nothing here touches the network or a real Google session — evidence is
explicitly MOCK.

Scenario matrix (NLO-P2 mission §4, ~15 required):
  1  fresh generation success (params mapped to enums, JSON-serializable)
  2  resume task in COMPLETED state   -> no re-submit
  3  resume task IN_PROGRESS state    -> no re-submit
  4  resume task NOT_FOUND state      -> no re-submit (unresolved, keep id)
  5  resume task FAILED state         -> proven failure, fresh submit
  6  invalid notebook id              -> NotFoundError (structured not_found)
  7  invalid source id                -> NotFoundError
  8  auth error on session            -> AuthError (classified "auth")
  9  rate limit on submit             -> RateLimitError (classified "rate_limit")
 10  unknown audio format             -> ValueError (classified "invalid_input")
 11  status poll: pending
 12  status poll: completed (url + metadata)
 13  status poll: failed + rate-limited error code
 14  status poll: not_found
 15  status poll: missing taskId      -> ValueError
 16  download success (size + SHA-256 + duration recorded)
 17  download: artifact not found     -> NotFoundError
 18  download: artifact not ready     -> {ready: false}
 19  download: wrong artifact kind    -> ValueError
 20  download: empty file             -> ValueError, partial removed
 21  download: exceeds size limit     -> ValueError, partial removed
 22  classify: built-in TimeoutError  -> "timeout"
 23  classify: ValueError             -> "invalid_input"
 24  classify: WaitTimeoutError       -> "timeout"
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any

import nbl_worker
from nbl_worker import (
    _classify,
    op_audio_download,
    op_audio_generate,
    op_audio_status,
)

from notebooklm.exceptions import AuthError, RateLimitError, WaitTimeoutError
from notebooklm.types import (
    Artifact,
    AudioFormat,
    AudioLength,
    GenerationState,
    GenerationStatus,
)

AUDIO_CODE = 1  # ArtifactTypeCode.AUDIO
REPORT_CODE = 2  # ArtifactTypeCode.REPORT


# ---------------------------------------------------------------------------
# Fakes (provider boundary)
# ---------------------------------------------------------------------------
class _Notebook:
    def __init__(self, nb_id: str, title: str) -> None:
        self.notebook_id = nb_id
        self.title = title


class _Source:
    def __init__(self, src_id: str, title: str) -> None:
        self.source_id = src_id
        self.id = src_id
        self.title = title


class FakeWorld:
    """Configurable fake NotebookLM backend state."""

    def __init__(self) -> None:
        self.notebooks: list[_Notebook] = [_Notebook("nb_1", "Notebook One")]
        self.sources: list[_Source] = [
            _Source("src_1", "source one"),
            _Source("src_2", "source two"),
        ]
        self.generate_calls: list[dict[str, Any]] = []
        self.poll_calls: list[str] = []
        self.poll_by_task: dict[str, GenerationStatus] = {}
        self.generate_result: GenerationStatus | None = None
        self.generate_raises: Exception | None = None
        self.artifact_by_id: dict[str, Artifact] = {}
        self.download_calls: list[tuple[str, str, str | None]] = []
        self.download_raises: Exception | None = None
        self.download_bytes: bytes = b"ID3\x03\x00fake-mp3-bytes-for-tests"
        self.download_size: int | None = None  # 0 -> write an empty file
        self.next_task_id = "task_1"
        self.client_path: Path | None = None
        self.client_timeout: float | None = None
        self.ctx_closed = False
        self.email = "mock-user@example.com"
        self.email_exc: Exception | None = None


class _Artifacts:
    def __init__(self, w: FakeWorld) -> None:
        self._w = w

    async def generate_audio(
        self,
        notebook_id: str,
        source_ids: list[str] | None = None,
        language: str | None = "en",
        instructions: str | None = None,
        audio_format: AudioFormat | None = None,
        audio_length: AudioLength | None = None,
    ) -> GenerationStatus:
        self._w.generate_calls.append(
            {
                "notebook_id": notebook_id,
                "source_ids": source_ids,
                "language": language,
                "instructions": instructions,
                "audio_format": audio_format,
                "audio_length": audio_length,
            }
        )
        if self._w.generate_raises is not None:
            raise self._w.generate_raises
        if self._w.generate_result is not None:
            return self._w.generate_result
        return GenerationStatus(
            task_id=self._w.next_task_id, status=GenerationState.PENDING
        )

    async def poll_status(self, notebook_id: str, task_id: str) -> GenerationStatus:
        self._w.poll_calls.append(task_id)
        return self._w.poll_by_task[task_id]

    async def get_or_none(self, notebook_id: str, artifact_id: str) -> Artifact | None:
        return self._w.artifact_by_id.get(artifact_id)

    async def download_audio(
        self,
        notebook_id: str,
        output_path: str,
        artifact_id: str | None = None,
        *,
        artifacts_data: list[Any] | None = None,  # noqa: ARG002
    ) -> str:
        self._w.download_calls.append((notebook_id, output_path, artifact_id))
        if self._w.download_raises is not None:
            raise self._w.download_raises
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        data = (
            self._w.download_bytes[: self._w.download_size]
            if self._w.download_size is not None
            else self._w.download_bytes
        )
        path.write_bytes(data)
        return output_path


class _Notebooks:
    def __init__(self, w: FakeWorld) -> None:
        self._w = w

    async def list(self) -> list[_Notebook]:
        return self._w.notebooks


class _Sources:
    def __init__(self, w: FakeWorld) -> None:
        self._w = w

    async def list(self, notebook_id: str) -> list[_Source]:  # noqa: ARG002
        return self._w.sources


class FakeClient:
    def __init__(self, w: FakeWorld) -> None:
        self.notebooks = _Notebooks(w)
        self.sources = _Sources(w)
        self.artifacts = _Artifacts(w)
        self._w = w

    async def get_account_email(self, live_fallback: bool = True) -> str:  # noqa: ARG002
        if self._w.email_exc is not None:
            raise self._w.email_exc
        return self._w.email


def make_artifact(
    artifact_id: str,
    *,
    code: int = AUDIO_CODE,
    completed: bool = True,
    duration: float | None = 3600.0,
) -> Artifact:
    return Artifact(
        id=artifact_id,
        title=f"audio overview {artifact_id}",
        _artifact_type=code,
        status=3 if completed else 2,  # COMPLETED / PROCESSING
        url=f"https://mock.example.com/audio/{artifact_id}.mp3" if completed else None,
        duration_seconds=duration,
    )


# ---------------------------------------------------------------------------
# Test case
# ---------------------------------------------------------------------------
class AudioOpsTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="nlo-audio-op-"))
        self.world = FakeWorld()
        self.emitted: list[dict[str, Any]] = []
        self._old_emit = nbl_worker.emit
        self._old_client_with = nbl_worker._client_with

        async def fake_emit(obj: dict[str, Any]) -> None:
            self.emitted.append(obj)

        class _Ctx:
            async def __aexit__(self, *args: Any) -> None:
                self._world.ctx_closed = True
                return None

        _Ctx._world = self.world

        async def fake_client_with(path: Path, timeout_sec: float) -> tuple[Any, FakeClient]:
            self.world.client_path = Path(path)
            self.world.client_timeout = timeout_sec
            return (_Ctx(), FakeClient(self.world))

        nbl_worker.emit = fake_emit
        nbl_worker._client_with = fake_client_with

    def tearDown(self) -> None:
        nbl_worker.emit = self._old_emit
        nbl_worker._client_with = self._old_client_with
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- helpers ------------------------------------------------------------
    def run_op(self, fn: Any, params: dict[str, Any]) -> Any:
        return asyncio.run(fn(params))

    def session(self) -> str:
        return str(self.tmp / "session.json")

    def base_params(self) -> dict[str, Any]:
        return {
            "sessionPath": self.session(),
            "notebookId": "nb_1",
            "sourceIds": ["src_1"],
            "prompt": "Make a podcast about this",
            "language": "fa",
            "audioFormat": "debate",
            "audioLength": "long",
            "timeoutSec": 60,
        }

    # -- audio_generate -------------------------------------------------------
    def test_generate_fresh_success(self) -> None:
        r = self.run_op(op_audio_generate, self.base_params())
        self.assertEqual(len(self.world.generate_calls), 1)
        call = self.world.generate_calls[0]
        self.assertEqual(call["notebook_id"], "nb_1")
        self.assertEqual(call["source_ids"], ["src_1"])
        self.assertEqual(call["language"], "fa")
        self.assertEqual(call["instructions"], "Make a podcast about this")
        self.assertEqual(call["audio_format"], AudioFormat.DEBATE)
        self.assertEqual(call["audio_length"], AudioLength.LONG)
        self.assertFalse(r["resumed"])
        self.assertEqual(r["taskId"], "task_1")
        self.assertEqual(r["status"], "pending")
        self.assertIsNone(r["priorStatus"])
        self.assertTrue(r["instructionsProvided"])
        self.assertEqual(self.world.poll_calls, [])  # no resume -> no poll
        json.dumps(r)  # protocol frame must stay JSON-serializable
        self.assertTrue(self.world.ctx_closed)

    def test_generate_resume_completed_no_resubmit(self) -> None:
        self.world.poll_by_task["task_9"] = GenerationStatus(
            task_id="task_9",
            status=GenerationState.COMPLETED,
            url="https://mock.example.com/audio/task_9.mp3",
            metadata={"durationSeconds": 123.0},
        )
        p = self.base_params()
        p["resumeTaskId"] = "task_9"
        r = self.run_op(op_audio_generate, p)
        self.assertEqual(self.world.generate_calls, [])  # NOT re-submitted
        self.assertEqual(self.world.poll_calls, ["task_9"])
        self.assertTrue(r["resumed"])
        self.assertEqual(r["taskId"], "task_9")
        self.assertEqual(r["status"], "completed")
        self.assertEqual(r["url"], "https://mock.example.com/audio/task_9.mp3")
        self.assertEqual(r["metadata"], {"durationSeconds": 123.0})
        json.dumps(r)

    def test_generate_resume_in_progress_no_resubmit(self) -> None:
        self.world.poll_by_task["task_5"] = GenerationStatus(
            task_id="task_5", status=GenerationState.IN_PROGRESS
        )
        p = self.base_params()
        p["resumeTaskId"] = "task_5"
        r = self.run_op(op_audio_generate, p)
        self.assertEqual(self.world.generate_calls, [])
        self.assertTrue(r["resumed"])
        self.assertEqual(r["status"], "in_progress")
        json.dumps(r)

    def test_generate_resume_not_found_keeps_task(self) -> None:
        # not_found is UNRESOLVED (delayed visibility vs deletion): never
        # re-submit on it — the caller keeps polling the same task id.
        self.world.poll_by_task["task_7"] = GenerationStatus(
            task_id="task_7", status=GenerationState.NOT_FOUND
        )
        p = self.base_params()
        p["resumeTaskId"] = "task_7"
        r = self.run_op(op_audio_generate, p)
        self.assertEqual(self.world.generate_calls, [])
        self.assertTrue(r["resumed"])
        self.assertEqual(r["status"], "not_found")
        json.dumps(r)

    def test_generate_resume_failed_resubmits(self) -> None:
        self.world.poll_by_task["task_3"] = GenerationStatus(
            task_id="task_3",
            status=GenerationState.FAILED,
            error="rate limit exceeded",
            error_code="USER_DISPLAYABLE_ERROR",
        )
        p = self.base_params()
        p["resumeTaskId"] = "task_3"
        r = self.run_op(op_audio_generate, p)
        # FAILED is proven failure -> a fresh submission is allowed.
        self.assertEqual(len(self.world.generate_calls), 1)
        self.assertFalse(r["resumed"])
        self.assertEqual(r["taskId"], "task_1")
        self.assertEqual(r["status"], "pending")
        self.assertEqual(r["priorStatus"], "failed")
        json.dumps(r)

    def test_generate_invalid_notebook(self) -> None:
        p = self.base_params()
        p["notebookId"] = "nb_missing"
        with self.assertRaises(Exception) as cm:
            self.run_op(op_audio_generate, p)
        code, _ = _classify(cm.exception)
        self.assertEqual(code, "not_found")
        self.assertEqual(self.world.generate_calls, [])

    def test_generate_invalid_source(self) -> None:
        p = self.base_params()
        p["sourceIds"] = ["src_missing"]
        with self.assertRaises(Exception) as cm:
            self.run_op(op_audio_generate, p)
        code, _ = _classify(cm.exception)
        self.assertEqual(code, "not_found")
        self.assertEqual(self.world.generate_calls, [])

    def test_generate_auth_error(self) -> None:
        self.world.email_exc = AuthError("session expired")
        with self.assertRaises(Exception) as cm:
            self.run_op(op_audio_generate, self.base_params())
        code, _ = _classify(cm.exception)
        self.assertEqual(code, "auth")

    def test_generate_rate_limit_on_submit(self) -> None:
        self.world.generate_raises = RateLimitError("slow down")
        with self.assertRaises(Exception) as cm:
            self.run_op(op_audio_generate, self.base_params())
        code, _ = _classify(cm.exception)
        self.assertEqual(code, "rate_limit")

    def test_generate_invalid_format(self) -> None:
        p = self.base_params()
        p["audioFormat"] = "bogus"
        with self.assertRaises(Exception) as cm:
            self.run_op(op_audio_generate, p)
        code, _ = _classify(cm.exception)
        self.assertEqual(code, "invalid_input")
        self.assertEqual(self.world.generate_calls, [])

    def test_generate_invalid_length(self) -> None:
        p = self.base_params()
        p["audioLength"] = "eternal"
        with self.assertRaises(Exception) as cm:
            self.run_op(op_audio_generate, p)
        code, _ = _classify(cm.exception)
        self.assertEqual(code, "invalid_input")

    def test_generate_without_source_ids_uses_all(self) -> None:
        p = self.base_params()
        p.pop("sourceIds")
        r = self.run_op(op_audio_generate, p)
        self.assertIsNone(self.world.generate_calls[0]["source_ids"])
        self.assertEqual(r["status"], "pending")

    # -- audio_status ----------------------------------------------------------
    def test_status_pending(self) -> None:
        self.world.poll_by_task["t1"] = GenerationStatus(
            task_id="t1", status=GenerationState.PENDING
        )
        r = self.run_op(
            op_audio_status,
            {"sessionPath": self.session(), "notebookId": "nb_1", "taskId": "t1"},
        )
        self.assertEqual(r["status"], "pending")
        self.assertFalse(r["isComplete"])
        self.assertFalse(r["isFailed"])
        self.assertFalse(r["isTerminal"])
        self.assertFalse(r["isNotFound"])
        json.dumps(r)

    def test_status_completed_with_metadata(self) -> None:
        self.world.poll_by_task["t2"] = GenerationStatus(
            task_id="t2",
            status=GenerationState.COMPLETED,
            url="https://mock.example.com/audio/t2.mp3",
            metadata={"durationSeconds": 456.0},
        )
        r = self.run_op(
            op_audio_status,
            {"sessionPath": self.session(), "notebookId": "nb_1", "taskId": "t2"},
        )
        self.assertEqual(r["status"], "completed")
        self.assertTrue(r["isComplete"])
        self.assertTrue(r["isTerminal"])
        self.assertEqual(r["url"], "https://mock.example.com/audio/t2.mp3")
        self.assertEqual(r["metadata"], {"durationSeconds": 456.0})
        json.dumps(r)

    def test_status_failed_rate_limited(self) -> None:
        self.world.poll_by_task["t3"] = GenerationStatus(
            task_id="t3",
            status=GenerationState.FAILED,
            error="quota exceeded",
            error_code="USER_DISPLAYABLE_ERROR",
        )
        r = self.run_op(
            op_audio_status,
            {"sessionPath": self.session(), "notebookId": "nb_1", "taskId": "t3"},
        )
        self.assertTrue(r["isFailed"])
        self.assertTrue(r["isTerminal"])
        self.assertTrue(r["isRateLimited"])
        self.assertEqual(r["error"], "quota exceeded")
        self.assertEqual(r["errorCode"], "USER_DISPLAYABLE_ERROR")
        json.dumps(r)

    def test_status_not_found(self) -> None:
        self.world.poll_by_task["t4"] = GenerationStatus(
            task_id="t4", status=GenerationState.NOT_FOUND
        )
        r = self.run_op(
            op_audio_status,
            {"sessionPath": self.session(), "notebookId": "nb_1", "taskId": "t4"},
        )
        self.assertTrue(r["isNotFound"])
        self.assertFalse(r["isTerminal"])  # unresolved: keep polling
        json.dumps(r)

    def test_status_missing_task_id(self) -> None:
        with self.assertRaises(Exception) as cm:
            self.run_op(
                op_audio_status,
                {"sessionPath": self.session(), "notebookId": "nb_1"},
            )
        code, _ = _classify(cm.exception)
        self.assertEqual(code, "invalid_input")

    # -- audio_download ---------------------------------------------------------
    def dest(self, name: str) -> str:
        return str(self.tmp / "out" / name)

    def test_download_success_records_hash(self) -> None:
        self.world.artifact_by_id["art_1"] = make_artifact("art_1")
        dest = self.dest("podcast.mp3")
        r = self.run_op(
            op_audio_download,
            {
                "sessionPath": self.session(),
                "notebookId": "nb_1",
                "artifactId": "art_1",
                "destPath": dest,
            },
        )
        self.assertTrue(r["ready"])
        self.assertEqual(r["path"], dest)
        expected = self.world.download_bytes
        self.assertEqual(r["size"], len(expected))
        self.assertEqual(r["sha256"], hashlib.sha256(expected).hexdigest())
        self.assertEqual(r["durationSeconds"], 3600.0)
        self.assertEqual(r["artifactId"], "art_1")
        ondisk = Path(dest)
        self.assertTrue(ondisk.is_file())
        self.assertEqual(ondisk.read_bytes(), expected)
        self.assertEqual(self.world.download_calls, [("nb_1", dest, "art_1")])
        json.dumps(r)

    def test_download_artifact_not_found(self) -> None:
        with self.assertRaises(Exception) as cm:
            self.run_op(
                op_audio_download,
                {
                    "sessionPath": self.session(),
                    "notebookId": "nb_1",
                    "artifactId": "art_x",
                    "destPath": self.dest("a.mp3"),
                },
            )
        code, _ = _classify(cm.exception)
        self.assertEqual(code, "not_found")

    def test_download_not_ready(self) -> None:
        self.world.artifact_by_id["art_2"] = make_artifact("art_2", completed=False)
        dest = self.dest("pending.mp3")
        r = self.run_op(
            op_audio_download,
            {
                "sessionPath": self.session(),
                "notebookId": "nb_1",
                "artifactId": "art_2",
                "destPath": dest,
            },
        )
        self.assertFalse(r["ready"])
        self.assertEqual(r["artifactStatus"], "in_progress")
        self.assertFalse(Path(dest).exists())
        self.assertEqual(self.world.download_calls, [])
        json.dumps(r)

    def test_download_wrong_kind(self) -> None:
        self.world.artifact_by_id["art_3"] = make_artifact(
            "art_3", code=REPORT_CODE
        )
        dest = self.dest("report.mp3")
        with self.assertRaises(Exception) as cm:
            self.run_op(
                op_audio_download,
                {
                    "sessionPath": self.session(),
                    "notebookId": "nb_1",
                    "artifactId": "art_3",
                    "destPath": dest,
                },
            )
        code, _ = _classify(cm.exception)
        self.assertEqual(code, "invalid_input")
        self.assertFalse(Path(dest).exists())

    def test_download_empty_file_removed(self) -> None:
        self.world.artifact_by_id["art_4"] = make_artifact("art_4")
        self.world.download_size = 0
        dest = self.dest("empty.mp3")
        with self.assertRaises(Exception) as cm:
            self.run_op(
                op_audio_download,
                {
                    "sessionPath": self.session(),
                    "notebookId": "nb_1",
                    "artifactId": "art_4",
                    "destPath": dest,
                },
            )
        code, _ = _classify(cm.exception)
        self.assertEqual(code, "invalid_input")
        self.assertFalse(Path(dest).exists())  # partial cleaned up

    def test_download_oversized_removed(self) -> None:
        self.world.artifact_by_id["art_5"] = make_artifact("art_5")
        dest = self.dest("big.mp3")
        with self.assertRaises(Exception) as cm:
            self.run_op(
                op_audio_download,
                {
                    "sessionPath": self.session(),
                    "notebookId": "nb_1",
                    "artifactId": "art_5",
                    "destPath": dest,
                    "maxBytes": 5,
                },
            )
        code, _ = _classify(cm.exception)
        self.assertEqual(code, "invalid_input")
        self.assertFalse(Path(dest).exists())

    def test_download_download_error_no_partial_claimed(self) -> None:
        self.world.artifact_by_id["art_6"] = make_artifact("art_6")
        self.world.download_raises = OSError("connection reset mid-transfer")
        dest = self.dest("broken.mp3")
        with self.assertRaises(Exception):
            self.run_op(
                op_audio_download,
                {
                    "sessionPath": self.session(),
                    "notebookId": "nb_1",
                    "artifactId": "art_6",
                    "destPath": dest,
                },
            )
        # An interrupted transfer must never be reported as a valid artifact.
        self.assertFalse(Path(dest).exists())

    # -- error classification ---------------------------------------------------
    def test_classify_builtin_timeout(self) -> None:
        code, msg = _classify(TimeoutError("wait timed out"))
        self.assertEqual(code, "timeout")
        self.assertIn("wait timed out", msg)

    def test_classify_value_error(self) -> None:
        code, _ = _classify(ValueError("bad param"))
        self.assertEqual(code, "invalid_input")

    def test_classify_wait_timeout_still_timeout(self) -> None:
        code, _ = _classify(WaitTimeoutError("generation wait timed out"))
        self.assertEqual(code, "timeout")

    # -- protocol integration -----------------------------------------------------
    def test_ops_registered_in_worker(self) -> None:
        self.assertIn("audio_generate", nbl_worker.OPS)
        self.assertIn("audio_status", nbl_worker.OPS)
        self.assertIn("audio_download", nbl_worker.OPS)

    def test_progress_events_emitted_for_generate(self) -> None:
        self.run_op(op_audio_generate, self.base_params())
        stages = [
            e.get("data", {}).get("stage")
            for e in self.emitted
            if e.get("event") == "progress"
        ]
        self.assertIn("submitting_audio", stages)
        self.assertIn("audio_submitted", stages)


if __name__ == "__main__":
    unittest.main(verbosity=2)
