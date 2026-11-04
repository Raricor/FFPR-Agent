"""The DeepSeek chat API (OpenAI-compatible). Only deepseek-flash is allowed.

deepseek-flash thinks by default (api-docs.deepseek.com/guides/thinking_mode): `effort` sets
how hard, "low", "high" (the default) or "max", and None turns thinking off. The reasoning
comes back in `reasoning_content`; with tools it must be sent back in later requests, which
ds/loop.py does. Sampling parameters such as temperature have no effect while thinking.
"""

import time

import httpx

BASE_URL = "https://api.deepseek.com"


# The user's choice (2026-10-20): Flash only (served by DeepSeek-V4.1-Flash), nothing else.
DEFAULT_MODEL = "deepseek-flash"


ALLOWED_MODELS = (DEFAULT_MODEL,)


RETRY_STATUS = {429, 500, 502, 503, 504}
EFFORTS = ("low", "high", "max")


class DeepSeek:
    def __init__(
        self,
        key: str,
        model: str,
        http: httpx.Client | None = None,
        sleep=time.sleep,
        effort: str | None = "high",
    ):
        if effort is not None and effort not in EFFORTS:
            raise ValueError(f"effort 只能是 {EFFORTS} 或 None")
        self.model = model
        self.effort = effort
        self.http = http or httpx.Client(base_url=BASE_URL, timeout=120)
        self.key = key
        self.sleep = sleep

    def chat(self, messages: list[dict], tools: list[dict]) -> dict:
        body = {"model": self.model, "messages": messages, "tools": tools}
        if self.effort is None:
            body["thinking"] = {"type": "disabled"}
        else:
            body["thinking"] = {"type": "enabled"}
            body["reasoning_effort"] = self.effort
        headers = {"Authorization": f"Bearer {self.key}"}
        for attempt in range(4):
            response = self.http.post("/chat/completions", json=body, headers=headers)
            if response.status_code not in RETRY_STATUS:
                break
            self.sleep(2**attempt)
        if response.status_code != 200:
            # Never echo the request: it carries the key in its headers.
            raise RuntimeError(f"DeepSeek 返回 {response.status_code}:{response.text[:300]}")
        return response.json()
