"""Hermes model-provider plugin backed by the official Google Antigravity CLI.

This integration deliberately does not read, copy, refresh, or forward Google OAuth
credentials. Authentication remains owned by the official ``agy`` process and its
normal local credential store. Hermes only launches the CLI as a subprocess.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from agent.acp_openai_bridge import (
    completion_to_stream_chunks,
    extract_tool_calls_from_text,
    render_tool_bridge_sections,
)
from providers import register_provider
from providers.base import ProviderProfile

_PROVIDER_ID = "antigravity-cli"
_DEFAULT_MODEL = "antigravity-default"
_BASE_URL = "acp://antigravity-cli"
_MODEL_LINE = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s{2,}(.+?)\s*$")


def _effective_timeout(value: Any) -> float:
    if isinstance(value, (int, float)):
        return max(1.0, float(value))
    candidates = [getattr(value, key, None) for key in ("read", "write", "connect", "pool", "timeout")]
    return max((float(item) for item in candidates if isinstance(item, (int, float))), default=900.0)


def _subprocess_env() -> dict[str, str]:
    # The official Antigravity CLI uses its own cached local credentials. Do not
    # forward Hermes' model-provider keys or messaging/service secrets.
    from tools.environments.local import hermes_subprocess_env

    return hermes_subprocess_env(inherit_credentials=False)


def _windows_creation_flags() -> int:
    try:
        from hermes_cli._subprocess_compat import windows_hide_flags

        return windows_hide_flags()
    except Exception:
        return 0


def _resolve_launch() -> tuple[str, list[str]]:
    from hermes_cli.auth import resolve_external_process_provider_credentials

    creds = resolve_external_process_provider_credentials(_PROVIDER_ID)
    return str(creds.get("command") or "agy"), list(creds.get("args") or [])


def _parse_models(stdout: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    seen: set[str] = set()
    for line in (stdout or "").splitlines():
        match = _MODEL_LINE.match(line)
        if not match:
            continue
        model_id, label = match.group(1).strip(), match.group(2).strip()
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        rows.append({"id": model_id, "label": label or model_id})
    return rows


def _probe_models(timeout: float = 8.0) -> tuple[list[dict[str, str]], str]:
    command, args = _resolve_launch()
    try:
        result = subprocess.run(
            [command, *args, "models"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            stdin=subprocess.DEVNULL,
            env=_subprocess_env(),
            creationflags=_windows_creation_flags(),
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as exc:
        return [], str(exc)
    if result.returncode != 0:
        return [], (result.stderr or result.stdout or f"agy models exited {result.returncode}").strip()
    return _parse_models(result.stdout), (result.stderr or "").strip()


def _render_message_content(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, dict):
        text = content.get("text")
        return str(text).strip() if text is not None else json.dumps(content, ensure_ascii=False)
    if isinstance(content, list):
        rendered: list[str] = []
        for item in content:
            if isinstance(item, str):
                if item.strip():
                    rendered.append(item.strip())
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                if item["text"].strip():
                    rendered.append(item["text"].strip())
        return "\n".join(rendered)
    return str(content).strip()


def _format_prompt(
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    tool_choice: Any,
) -> str:
    sections = [
        "You are the model backend for Hermes Agent.",
        "Do not modify the user's project with your own filesystem, shell, browser, or agent tools. "
        "Hermes owns all external actions. If an external action is required, request one of the "
        "Hermes tools described below using the exact tool-call format.",
        *render_tool_bridge_sections(tools, tool_choice),
    ]
    transcript: list[str] = []
    for message in messages or []:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "context").strip().lower()
        content = _render_message_content(message.get("content"))
        if content:
            transcript.append(f"{role.upper()}:\n{content}")
    if transcript:
        sections.append("Conversation transcript:\n\n" + "\n\n".join(transcript))
    sections.append("Respond to the latest user request now.")
    return "\n\n".join(section.strip() for section in sections if section and section.strip())


def _parse_result(stdout: str) -> dict[str, Any]:
    terminal: dict[str, Any] | None = None
    for raw_line in (stdout or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except Exception:
            continue
        if not isinstance(payload, dict):
            continue
        if payload.get("event") == "result" and isinstance(payload.get("result"), dict):
            terminal = payload["result"]
    if terminal is None:
        raise RuntimeError("Antigravity CLI produced no terminal result event.")
    return terminal


class AntigravityCliClient:
    """Small OpenAI-compatible facade around official ``agy`` headless mode."""

    HERMES_SKIP_TRANSPORT_WRAP = True
    HERMES_SKIP_ASYNC_WRAP = True

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        default_headers: dict[str, str] | None = None,
        command: str | None = None,
        args: list[str] | None = None,
        **_: Any,
    ) -> None:
        self.api_key = api_key or _PROVIDER_ID
        self.base_url = base_url or _BASE_URL
        self._default_headers = dict(default_headers or {})
        self._command = command or "agy"
        self._args = list(args or [])
        self._active: set[subprocess.Popen[str]] = set()
        self._lock = threading.Lock()
        self.is_closed = False
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create_chat_completion))

    @staticmethod
    def _stop_process(process: subprocess.Popen[str]) -> None:
        with contextlib.suppress(Exception):
            process.terminate()
            process.wait(timeout=2)
            return
        with contextlib.suppress(Exception):
            process.kill()

    def cancel(self) -> None:
        with self._lock:
            processes = tuple(self._active)
        for process in processes:
            self._stop_process(process)

    def close(self) -> None:
        with self._lock:
            processes, self._active = tuple(self._active), set()
            self.is_closed = True
        for process in processes:
            self._stop_process(process)

    def _create_chat_completion(
        self,
        *,
        model: str | None = None,
        messages: list[dict[str, Any]] | None = None,
        timeout: Any = None,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: Any = None,
        stream: bool = False,
        **_: Any,
    ) -> Any:
        prompt = _format_prompt(messages or [], tools, tool_choice)
        timeout_seconds = _effective_timeout(timeout)
        selected_model = str(model or "").strip()

        workdir = tempfile.mkdtemp(prefix="hermes-antigravity-")
        argv = [
            self._command,
            *self._args,
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--sandbox",
        ]
        if selected_model and selected_model not in {_DEFAULT_MODEL, _PROVIDER_ID}:
            argv.extend(["--model", selected_model])

        process: subprocess.Popen[str] | None = None
        try:
            process = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                cwd=workdir,
                env=_subprocess_env(),
                creationflags=_windows_creation_flags(),
            )
            with self._lock:
                self._active.add(process)
                self.is_closed = False

            request = json.dumps(
                {"event": "user", "message": {"content": prompt}},
                ensure_ascii=False,
            ) + "\n"
            try:
                stdout, stderr = process.communicate(input=request, timeout=timeout_seconds)
            except subprocess.TimeoutExpired as exc:
                self._stop_process(process)
                raise TimeoutError(f"Antigravity CLI timed out after {timeout_seconds:.0f}s.") from exc

            terminal = _parse_result(stdout)
            status = str(terminal.get("status") or "").upper()
            if process.returncode != 0 or status != "SUCCESS":
                detail = str(terminal.get("error") or stderr or f"status={status or 'unknown'}").strip()
                raise RuntimeError(f"Antigravity CLI request failed: {detail}")

            response_text = str(terminal.get("response") or "")
            tool_calls, cleaned_text = extract_tool_calls_from_text(response_text)
            usage = terminal.get("usage") if isinstance(terminal.get("usage"), dict) else {}
            prompt_tokens = int(usage.get("input_tokens") or 0)
            completion_tokens = int(usage.get("output_tokens") or 0)
            total_tokens = int(usage.get("total_tokens") or (prompt_tokens + completion_tokens))
            cached_tokens = int(usage.get("cache_read_tokens") or 0)

            message = SimpleNamespace(
                content=cleaned_text,
                tool_calls=tool_calls,
                reasoning=None,
                reasoning_content=None,
                reasoning_details=None,
            )
            completion = SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=message,
                        finish_reason="tool_calls" if tool_calls else "stop",
                    )
                ],
                usage=SimpleNamespace(
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    total_tokens=total_tokens,
                    prompt_tokens_details=SimpleNamespace(cached_tokens=cached_tokens),
                ),
                model=selected_model or _DEFAULT_MODEL,
            )
            return completion_to_stream_chunks(completion) if stream else completion
        except FileNotFoundError as exc:
            raise RuntimeError(
                "Could not start the official Antigravity CLI (`agy`). Install/sign in to Antigravity CLI, "
                "or set HERMES_ANTIGRAVITY_CLI_COMMAND."
            ) from exc
        finally:
            if process is not None:
                with self._lock:
                    self._active.discard(process)
                    if not self._active:
                        self.is_closed = True
                if process.poll() is None:
                    self._stop_process(process)
            shutil.rmtree(workdir, ignore_errors=True)


class AntigravityCliProfile(ProviderProfile):
    def create_client(self, **client_kwargs: Any) -> Any:
        return AntigravityCliClient(**client_kwargs)

    def fetch_models(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: float = 8.0,
    ) -> list[str] | None:
        rows, _detail = _probe_models(timeout=timeout)
        return [row["id"] for row in rows] or None

    def discover_models(self, **_: Any) -> list[dict[str, str]]:
        rows, _detail = _probe_models()
        return [
            {"id": _DEFAULT_MODEL, "label": "Antigravity Default", "note": "official agy CLI"},
            *rows,
        ]

    def setup_status(self, **_: Any) -> dict[str, Any]:
        try:
            command, _args = _resolve_launch()
        except Exception as exc:
            return {
                "available": False,
                "logged_in": False,
                "plan": None,
                "detail": str(exc),
                "login_command": None,
            }
        if shutil.which(command) is None and not Path(command).is_file():
            return {
                "available": False,
                "logged_in": False,
                "plan": None,
                "detail": f"Antigravity CLI command not found: {command}",
                "login_command": None,
            }
        rows, detail = _probe_models()
        return {
            "available": True,
            "logged_in": bool(rows),
            "plan": None,
            "detail": detail if not rows else "",
            "login_command": None if rows else command,
        }


profile = AntigravityCliProfile(
    name=_PROVIDER_ID,
    aliases=("antigravity", "agy"),
    display_name="Google Antigravity CLI",
    description="Official agy CLI subprocess; Google credentials stay owned by Antigravity",
    api_mode="chat_completions",
    env_vars=(),
    base_url=_BASE_URL,
    auth_type="external_process",
    process_command="agy",
    process_args=(),
    process_command_env_vars=("HERMES_ANTIGRAVITY_CLI_COMMAND", "ANTIGRAVITY_CLI_PATH"),
    process_args_env_var="HERMES_ANTIGRAVITY_CLI_ARGS",
    fallback_models=(_DEFAULT_MODEL,),
)

register_provider(profile)
