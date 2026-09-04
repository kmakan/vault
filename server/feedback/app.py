#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Vault feedback receiver: POST /api/feedback -> sqlite.
WSGI app, run via gunicorn (already installed on the VPS).
No external deps beyond stdlib.
"""
import json
import os
import re
import sqlite3
import time
from datetime import datetime, timezone

DB = os.environ.get("VAULT_FEEDBACK_DB", "/home/maksim/vault-feedback/feedback.db")
MAX_BODY = 16 * 1024
RATE_WINDOW = 3600  # seconds
RATE_MAX = 10       # messages per hour per IP

_ok = re.compile(r"^[\w.+-]+@[\w.-]+\.\w+$")


def _db():
    d = os.path.dirname(DB)
    os.makedirs(d, exist_ok=True)
    con = sqlite3.connect(DB, timeout=5)
    con.execute(
        "CREATE TABLE IF NOT EXISTS feedback ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " ts TEXT NOT NULL, ip TEXT, version TEXT, account TEXT,"
        " ua TEXT, text TEXT NOT NULL)"
    )
    con.commit()
    return con


def _rate_limited(con, ip):
    since = datetime.fromtimestamp(time.time() - RATE_WINDOW, tz=timezone.utc).isoformat(
        timespec="seconds")
    cur = con.execute(
        "SELECT COUNT(*) FROM feedback WHERE ip=? AND ts>?", (ip, since))
    return cur.fetchone()[0] >= RATE_MAX


def _json(start_response, code, obj, cors=True):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    headers = [("Content-Type", "application/json; charset=utf-8"),
               ("Content-Length", str(len(body))),
               ("Cache-Control", "no-store")]
    if cors:
        headers.append(("Access-Control-Allow-Origin", "*"))
    start_response(
        "%d %s" % (code, "OK" if code < 400 else "ERR"),
        headers,
    )
    return [body]


def application(environ, start_response):
    path = environ.get("PATH_INFO", "/")
    method = environ.get("REQUEST_METHOD", "GET")

    # CORS preflight (WebView sends OPTIONS for application/json POSTs)
    if method == "OPTIONS" and path == "/api/feedback":
        start_response("204 No Content", [
            ("Access-Control-Allow-Origin", "*"),
            ("Access-Control-Allow-Methods", "POST, OPTIONS"),
            ("Access-Control-Allow-Headers", "Content-Type"),
            ("Access-Control-Max-Age", "86400"),
            ("Content-Length", "0"),
        ])
        return []

    if method == "GET" and path in ("/api/feedback", "/api/health"):
        return _json(start_response, 200, {"ok": True, "service": "vault-feedback"})

    if method != "POST" or path != "/api/feedback":
        return _json(start_response, 404, {"error": "not found"})

    try:
        length = int(environ.get("CONTENT_LENGTH") or 0)
    except ValueError:
        length = 0
    if length <= 0 or length > MAX_BODY:
        return _json(start_response, 413, {"error": "bad size"})

    try:
        data = json.loads(environ["wsgi.input"].read(length).decode("utf-8"))
    except Exception:
        return _json(start_response, 400, {"error": "bad json"})

    text = (data.get("text") or "").strip()[:4000]
    if not text:
        return _json(start_response, 400, {"error": "empty"})

    account = (data.get("account") or "")[:120]
    if account and not _ok.match(account):
        account = ""

    ip = environ.get("HTTP_X_REAL_IP") or environ.get("REMOTE_ADDR") or ""
    con = _db()
    try:
        if _rate_limited(con, ip):
            return _json(start_response, 429, {"error": "rate limit"})
        con.execute(
            "INSERT INTO feedback (ts, ip, version, account, ua, text) VALUES (?,?,?,?,?,?)",
            (datetime.now(timezone.utc).isoformat(timespec="seconds"),
             ip, (data.get("version") or "")[:32], account,
             (data.get("ua") or "")[:300], text),
        )
        con.commit()
    finally:
        con.close()
    return _json(start_response, 200, {"ok": True})
