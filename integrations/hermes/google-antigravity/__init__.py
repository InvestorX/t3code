"""Google Antigravity model-provider plugin for Hermes Agent.

This is a current-Plugin-API port of the native Antigravity provider that was
merged into Hermes Agent in PR #50454.  The old implementation owned its own
OAuth token file and patched several CLI registries.  Modern Hermes model
provider plugins no longer need either: ProviderProfile registration wires the
provider into model/runtime discovery, and the shared PKCE credential-pool
helpers own login, persistence, refresh, and concurrency.
"""

from __future__ import annotations

import json
import os
import uuid
from typing import Any, Dict, Iterable, Iterator, List, Optional

import httpx

from agent.gemini_native_adapter import (
    GeminiNativeClient,
    _iter_sse_events,
    build_gemini_request,
    gemini_http_error,
    translate_gemini_response,
    translate_stream_event,
)
from hermes_cli.auth_oauth_pkce_plugin import (
    OAuthPKCEConfig,
    pkce_auth_handler,
    pkce_refresh_credential,
)
from providers import register_provider
from providers.base import ProviderProfile

PROVIDER_ID = "google-antigravity"
DISPLAY_NAME = "Google Antigravity"

ANTIGRAVITY_CODE_ASSIST_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com"
ANTIGRAVITY_MODEL_ENDPOINTS = (
    ANTIGRAVITY_CODE_ASSIST_ENDPOINT,
    "https://cloudcode-pa.googleapis.com",
    "https://autopush-cloudcode-pa.sandbox.googleapis.com",
)

ANTIGRAVITY_CLIENT_METADATA = {
    "ideType": "ANTIGRAVITY",
    "platform": "PLATFORM_UNSPECIFIED",
    "pluginType": "GEMINI",
}
ANTIGRAVITY_USER_AGENT = "antigravity/1.0.0 windows/amd64"
ANTIGRAVITY_X_GOOG_API_CLIENT = "google-cloud-sdk vscode_cloudshelleditor/0.1"

# Public installed-app OAuth credentials used by the Antigravity desktop/CLI
# flow. Installed-app client secrets are not confidential; PKCE is the proof.
_PUBLIC_CLIENT_ID_PROJECT_NUM = "1071006060591"
_PUBLIC_CLIENT_ID_HASH = "tmhssin2h21lcre235vtolojh4g403ep"
_PUBLIC_CLIENT_SECRET_SUFFIX = "K58FWR486LdLJ1mLB8sXC4z6qDAf"
PUBLIC_CLIENT_ID = (
    f"{_PUBLIC_CLIENT_ID_PROJECT_NUM}-{_PUBLIC_CLIENT_ID_HASH}.apps.googleusercontent.com"
)
PUBLIC_CLIENT_SECRET = f"GOCSPX-{_PUBLIC_CLIENT_SECRET_SUFFIX}"

DEFAULT_PROJECT_ID = "rising-fact-p41fc"
DEFAULT_AGENT_MODEL_IDS = (
    "gemini-3-flash-agent",
    "gemini-3.5-flash-low",
    "gemini-pro-agent",
    "gemini-3.1-pro-low",
    "claude-sonnet-4-6",
    "claude-opus-4-6-thinking",
    "gpt-oss-120b-medium",
)
DEPRECATED_MODEL_REPLACEMENTS = {"gemini-3.1-pro-high": "gemini-pro-agent"}

OAUTH = OAuthPKCEConfig(
    client_id=PUBLIC_CLIENT_ID,
    authorize_url="https://accounts.google.com/o/oauth2/v2/auth",
    token_url="https://oauth2.googleapis.com/token",
    scopes=(
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/cclog",
        "https://www.googleapis.com/auth/experimentsandconfigs",
    ),
    redirect_port=51121,
    redirect_path="/oauth-callback",
    extra_authorize_params={"access_type": "offline", "prompt": "consent"},
    extra_token_params={"client_secret": PUBLIC_CLIENT_SECRET},
    allowed_hosts=("google.com", "googleapis.com"),
    timeout_seconds=300.0,
    label=DISPLAY_NAME,
)


def _client_metadata() -> Dict[str, str]:
    return dict(ANTIGRAVITY_CLIENT_METADATA)


def _headers(access_token: str, *, accept: str = "application/json") -> Dict[str, str]:
    return {
        "Content-Type": "application/json",
        "Accept": accept,
        "Authorization": f"Bearer {access_token}",
        "User-Agent": ANTIGRAVITY_USER_AGENT,
        "X-Goog-Api-Client": ANTIGRAVITY_X_GOOG_API_CLIENT,
        "Client-Metadata": json.dumps(_client_metadata(), separators=(",", ":")),
        "x-activity-request-id": str(uuid.uuid4()),
    }


def _post_json(
    url: str,
    body: Dict[str, Any],
    access_token: str,
    *,
    timeout: float = 30.0,
) -> Dict[str, Any]:
    with httpx.Client(timeout=timeout) as client:
        response = client.post(url, json=body, headers=_headers(access_token))
    if response.status_code != 200:
        raise gemini_http_error(response, api_key=access_token, base_url=ANTIGRAVITY_CODE_ASSIST_ENDPOINT)
    payload = response.json()
    return payload if isinstance(payload, dict) else {}


def _configured_project_id() -> str:
    for key in (
        "HERMES_ANTIGRAVITY_PROJECT_ID",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_PROJECT_ID",
    ):
        value = (os.getenv(key) or "").strip()
        if value:
            return value
    return ""


def resolve_project_id(access_token: str) -> str:
    configured = _configured_project_id()
    if configured:
        return configured

    payload = _post_json(
        f"{ANTIGRAVITY_CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist",
        {"metadata": _client_metadata()},
        access_token,
    )
    discovered = (
        str(payload.get("cloudaicompanionProject") or "").strip()
        or str(payload.get("project") or "").strip()
    )
    return discovered or DEFAULT_PROJECT_ID


def _model_id(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in ("modelId", "model_id", "id", "name"):
            candidate = str(value.get(key) or "").strip()
            if candidate:
                return candidate
    return ""


def _ids_from_sort(sort: Dict[str, Any]) -> List[str]:
    result: List[str] = []
    for key in ("modelIds", "model_ids", "models", "modelSorts"):
        value = sort.get(key)
        if isinstance(value, list):
            result.extend(mid for item in value if (mid := _model_id(item)))
        elif isinstance(value, dict):
            mid = _model_id(value)
            if mid:
                result.append(mid)
    return result


def _is_recommended_sort(sort: Dict[str, Any]) -> bool:
    label = " ".join(
        str(sort.get(key) or "")
        for key in ("name", "displayName", "title", "category", "group")
    ).lower()
    return "recommended" in label


def _filter_agent_models(ids: Iterable[str]) -> List[str]:
    raw = [str(model).strip() for model in ids if str(model).strip()]
    seen: set[str] = set()
    result: List[str] = []
    for model in raw:
        if model in seen or model.startswith(("chat_", "tab_")):
            continue
        replacement = DEPRECATED_MODEL_REPLACEMENTS.get(model)
        if replacement and replacement in raw:
            continue
        seen.add(model)
        result.append(model)
    return result


def parse_agent_models(payload: Dict[str, Any]) -> List[str]:
    ordered: List[str] = []
    sorts = payload.get("agentModelSorts")
    if isinstance(sorts, list):
        rows = [row for row in sorts if isinstance(row, dict)]
        rows.sort(key=lambda row: 0 if _is_recommended_sort(row) else 1)
        for row in rows:
            ordered.extend(_ids_from_sort(row))

    if not ordered:
        default = str(payload.get("defaultAgentModelId") or "").strip()
        if default:
            ordered.append(default)
        ordered.extend(DEFAULT_AGENT_MODEL_IDS)
        models = payload.get("models")
        if isinstance(models, list):
            ordered.extend(mid for item in models if (mid := _model_id(item)))

    return _filter_agent_models(ordered) or list(DEFAULT_AGENT_MODEL_IDS)


def fetch_available_models(access_token: str, project_id: str) -> List[str]:
    last_error: Optional[Exception] = None
    for endpoint in ANTIGRAVITY_MODEL_ENDPOINTS:
        try:
            payload = _post_json(
                f"{endpoint}/v1internal:fetchAvailableModels",
                {"project": project_id} if project_id else {},
                access_token,
            )
            models = parse_agent_models(payload)
            if models:
                return models
        except Exception as exc:  # catalog fallback should not make the provider unusable
            last_error = exc
    if last_error is not None:
        return list(DEFAULT_AGENT_MODEL_IDS)
    return list(DEFAULT_AGENT_MODEL_IDS)


def wrap_code_assist_request(project_id: str, model: str, request: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "project": project_id,
        "model": model,
        "user_prompt_id": str(uuid.uuid4()),
        "request": request,
    }


class AntigravityCloudCodeClient(GeminiNativeClient):
    """OpenAI-shaped Hermes client backed by Antigravity Code Assist."""

    HERMES_SKIP_TRANSPORT_WRAP = True

    def __init__(self, *, api_key: str, project_id: str = "", **kwargs: Any) -> None:
        super().__init__(api_key=api_key or "antigravity-oauth", **kwargs)
        self._project_id = project_id.strip()

    def _project(self) -> str:
        if not self._project_id:
            self._project_id = resolve_project_id(self.api_key)
        return self._project_id

    def _antigravity_headers(self, *, streaming: bool = False) -> Dict[str, str]:
        headers = _headers(
            self.api_key,
            accept="text/event-stream" if streaming else "application/json",
        )
        headers.update(self._default_headers)
        return headers

    def _create_chat_completion(
        self,
        *,
        model: str = DEFAULT_AGENT_MODEL_IDS[0],
        messages: Optional[List[Dict[str, Any]]] = None,
        stream: bool = False,
        tools: Any = None,
        tool_choice: Any = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        top_p: Optional[float] = None,
        stop: Any = None,
        response_format: Any = None,
        extra_body: Optional[Dict[str, Any]] = None,
        timeout: Any = None,
        **_: Any,
    ) -> Any:
        extra = extra_body if isinstance(extra_body, dict) else {}
        inner = build_gemini_request(
            messages=messages or [],
            tools=tools,
            tool_choice=tool_choice,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
            stop=stop,
            thinking_config=extra.get("thinking_config") or extra.get("thinkingConfig"),
            response_format=response_format or extra.get("response_format"),
            model=model,
            tools_as_json_schema=False,
        )
        wrapped = wrap_code_assist_request(self._project(), model, inner)

        if stream:
            return self._stream_antigravity(model, wrapped, timeout)

        response = self._http.post(
            f"{ANTIGRAVITY_CODE_ASSIST_ENDPOINT}/v1internal:generateContent",
            json=wrapped,
            headers=self._antigravity_headers(),
            timeout=timeout,
        )
        if response.status_code != 200:
            raise gemini_http_error(
                response,
                api_key=self.api_key,
                base_url=ANTIGRAVITY_CODE_ASSIST_ENDPOINT,
            )
        payload = response.json()
        inner_response = payload.get("response") if isinstance(payload, dict) else None
        if not isinstance(inner_response, dict):
            inner_response = payload if isinstance(payload, dict) else {}
        return translate_gemini_response(inner_response, model=model)

    def _stream_antigravity(
        self,
        model: str,
        wrapped: Dict[str, Any],
        timeout: Any,
    ) -> Iterator[Any]:
        url = f"{ANTIGRAVITY_CODE_ASSIST_ENDPOINT}/v1internal:streamGenerateContent?alt=sse"
        try:
            with self._http.stream(
                "POST",
                url,
                json=wrapped,
                headers=self._antigravity_headers(streaming=True),
                timeout=timeout,
            ) as response:
                if response.status_code != 200:
                    response.read()
                    raise gemini_http_error(
                        response,
                        api_key=self.api_key,
                        base_url=ANTIGRAVITY_CODE_ASSIST_ENDPOINT,
                    )
                tool_call_indices: Dict[str, Dict[str, Any]] = {}
                for event in _iter_sse_events(response):
                    inner = event.get("response") if isinstance(event.get("response"), dict) else event
                    yield from translate_stream_event(inner, model, tool_call_indices)
        except httpx.HTTPError as exc:
            from agent.gemini_native_adapter import GeminiAPIError

            raise GeminiAPIError(
                f"Antigravity streaming request failed: {exc}",
                code="antigravity_code_assist_stream_error",
            ) from exc


class AntigravityProfile(ProviderProfile):
    def fetch_models(
        self,
        *,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: float = 8.0,
    ) -> Optional[List[str]]:
        token = str(api_key or "").strip()
        if not token:
            return list(self.fallback_models)
        try:
            return fetch_available_models(token, resolve_project_id(token))
        except Exception:
            return list(self.fallback_models)

    def create_client(self, **client_kwargs: Any) -> Any:
        token = str(client_kwargs.get("api_key") or "").strip()
        if not token:
            raise RuntimeError(
                "Google Antigravity is not authenticated. Run `hermes auth add google-antigravity`."
            )
        allowed = {
            key: client_kwargs[key]
            for key in ("default_headers", "timeout", "http_client")
            if client_kwargs.get(key) is not None
        }
        return AntigravityCloudCodeClient(
            api_key=token,
            project_id=_configured_project_id(),
            **allowed,
        )


profile = AntigravityProfile(
    name=PROVIDER_ID,
    aliases=("antigravity", "antigravity-oauth", "agy"),
    api_mode="chat_completions",
    display_name=DISPLAY_NAME,
    description="Google Antigravity subscription models through Code Assist OAuth",
    signup_url="https://antigravity.google/",
    base_url=ANTIGRAVITY_CODE_ASSIST_ENDPOINT,
    auth_type="oauth_external",
    auth_handler=pkce_auth_handler(OAUTH),
    refresh_credential=pkce_refresh_credential(OAUTH),
    supports_health_check=False,
    supports_model_listing=True,
    supports_vision=True,
    default_aux_model=DEFAULT_AGENT_MODEL_IDS[0],
    fallback_models=DEFAULT_AGENT_MODEL_IDS,
)

register_provider(profile)
