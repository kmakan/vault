#!/usr/bin/env python3
"""VaultBot bridge (M2 bots-2) — thin HTTP relay between the Vault bot
account and a local OpenAI-compatible agent API.

Wiring (one pipe, two processes):

    vault --listen  <stdin NDJSON cmds | stdout NDJSON events >
         ^                                    v
         |                                    |
         +---------------- vaultbot.py --------+

vaultbot.py reads line events {"type":"msg","from","id","text"} on stdin,
POSTs the text to HERMES_API_URL (default http://127.0.0.1:8642)
/v1/chat/completions with header X-Hermes-Session-Id keyed per sender
(stable conversation memory per user), then prints
{"action":"send","to":...,"text":...,"reply_to":...} on stdout for the
listener to encrypt and deliver.

Config via environment (never in code):
    VAULTBOT_API_URL   — base URL of the agent API (required)
    VAULTBOT_API_KEY   — bearer token
    VAULTBOT_MODEL     — model name (default: hermes)
    VAULTBOT_BOT_NAME  — display name the bot signs replies with
    VAULTBOT_TIMEOUT   — API timeout seconds (default 120)

Privacy note (design doc §2.1): the user<->bot leg is E2E; the bridge sees
plaintext by necessity (same trust model as any chatbot backend). Run both
the bridge and the agent API on infrastructure you control.
"""
import json
import os
import sys
import urllib.request
import urllib.error

API_URL = os.environ.get("VAULTBOT_API_URL", "").rstrip("/")
API_KEY = os.environ.get("VAULTBOT_API_KEY", "")
MODEL = os.environ.get("VAULTBOT_MODEL", "hermes")
TIMEOUT = int(os.environ.get("VAULTBOT_TIMEOUT", "120"))
MAX_REPLY = int(os.environ.get("VAULTBOT_MAX_REPLY", "4000"))
# system prompt shapes the bot persona; keep short — history carries context
SYSTEM = os.environ.get(
    "VAULTBOT_SYSTEM",
    "You are VaultBot, a helpful assistant reachable through an E2E-encrypted "
    "messaging channel. Keep replies compact and plain-text (no markdown "
    "tables; code blocks are fine). The sender sees only your final text.",
)

_hist = {}  # sender email -> [{role, content}] (bounded)


def log(msg: str) -> None:
    print(f"[vaultbot] {msg}", file=sys.stderr, flush=True)


def ask_agent(email: str, text: str) -> str | None:
    """One OpenAI-compatible completion with per-user session continuity."""
    hist = _hist.setdefault(email, [])
    hist.append({"role": "user", "content": text})
    messages = [{"role": "system", "content": SYSTEM}] + hist[-24:]
    # reasoning_effort: the gateway default (high) lets thinking models burn
    # the whole output budget before answering ("Thinking Budget Exhausted").
    # A chatbot relay wants a fast compact reply.
    body = json.dumps({
        "model": MODEL,
        "messages": messages,
        "model_options": {"reasoning_effort": os.environ.get("VAULTBOT_REASONING", "low")},
    }).encode()
    req = urllib.request.Request(
        API_URL + "/v1/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}",
            # continuity header: the gateway keeps one agent session per user
            "X-Hermes-Session-Id": f"vault:{email}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            reply = json.loads(r.read())
    except urllib.error.HTTPError as e:
        log(f"api http {e.code}: {e.read()[:200]!r}")
        return None
    except Exception as e:  # network/JSON
        log(f"api error: {e}")
        return None
    try:
        choice = reply["choices"][0]
        content = (choice["message"]["content"] or "").strip()
    except (KeyError, IndexError):
        log(f"bad api shape: {json.dumps(reply)[:200]}")
        return None
    if not content:
        return None
    hist.append({"role": "assistant", "content": content})
    return content[:MAX_REPLY]


def main() -> int:
    if not API_URL:
        log("VAULTBOT_API_URL is not set")
        return 2
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") != "msg":
            continue
        sender = (ev.get("from") or "").strip().lower()
        text = ev.get("text") or ""
        if not sender or not text:
            continue
        answer = ask_agent(sender, text)
        if answer is None:
            answer = "(the assistant is unreachable right now, try again in a moment)"
        cmd = {"action": "send", "to": sender, "text": answer,
               "reply_to": ev.get("id", "")}
        sys.stdout.write(json.dumps(cmd, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
