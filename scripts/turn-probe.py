"""Внешняя проба TURN: Allocate на coturn без кредов (ожидаем 401 с realm и
nonce) и с MESSAGE-INTEGRITY (ожидаем 0x0103 — успех, relay-адрес и lifetime).

Креды приходят из окружения (TU — username вида «<истечение>:<метка>», TP —
credential), хост — TURN_HOST. В вывод секрет не попадает: печатаем коды
ответов, relay-адрес и сроки.

Три правила, без которых проба врёт (увидено на живом coturn 4.5.1.1):
* ключ MESSAGE-INTEGRITY = RAW-дайджест md5("user:realm:credential"), 16 байт.
  hex-строка выглядит правдоподобно и даёт 401 Unauthorized — это выглядит как
  «секрет не совпал», хотя секрет верный;
* nonce coturn проверяет по транспортному адресу, поэтому весь цикл рукопожатия
  идёт на ОДНОМ сокете. На другом сокет ответ — 438 Wrong nonce, и он приходит
  РАНЬШЕ проверки ключа, то есть 438 ничего не говорит о кредах;
* в запросе не бывает XOR-MAPPED-ADDRESS (это атрибут ответа) — coturn на него
  отвечает 420/437.

Числа атрибутов и маска XOR — как у нашей же стековой реализации (rtc-stun
0.20.3: ATTR_XOR_RELAYED_ADDRESS=0x0016, ATTR_LIFETIME=0x000D, IPv4 XORится только
с magic cookie, без transaction id). Это черновые номера RFC-5766-draft, и coturn
отвечает теми же — пробник разбирает то, что разбирает приложение, а не «как в
FINAL-таблице IANA».

Зачем отдельный скрипт: симптом битого TURN на клиенте молчаливый («звонка
нет»), а тут ответ coturn виден шаг за шагом — 401 без кредов доказывает, что
сервер живёт и требует auth; 401 на шаге 2 — что секрет или срок не совпали;
0x0103 с relay-адресом — что путь через релей открыт и диапазон UDP не режут.
"""
import socket, struct, os, hmac, hashlib

U = os.environ.get("TU", "").strip()
P = os.environ.get("TP", "").strip()
HOST = os.environ.get("TURN_HOST", "185.180.199.237")
PORT = int(os.environ.get("TURN_PORT", "3478"))
COOKIE = 0x2112A442

USERNAME, MI, ERROR_CODE, REALM, NONCE = 0x0006, 0x0008, 0x0009, 0x0014, 0x0015
REQ_TRANSPORT, SOFTWARE, XOR_MAPPED = 0x0019, 0x8022, 0x0020
XOR_RELAY, LIFETIME = 0x0016, 0x000D
REQUEST, ALLOCATE_SUCCESS = 0x0003, 0x0103


def attr(t, v):
    b = v if isinstance(v, bytes) else str(v).encode()
    return struct.pack(">HH", t, len(b)) + b + b"\x00" * ((4 - len(b) % 4) % 4)


def build(mtype, tid, body, key=None):
    if key is not None:
        h = struct.pack(">HHI", mtype, len(body) + 24, COOKIE) + tid + body
        body = body + attr(MI, hmac.new(key, h, hashlib.sha1).digest())
    return struct.pack(">HHI", mtype, len(body), COOKIE) + tid + body


def xor_addr(v):
    """IPv4 из XOR-адреса coturn: порт и 4 байта адреса перемножены с magic
    cookie (наша стековая реализация делает ровно так же)."""
    port = struct.unpack(">H", v[2:4])[0] ^ (COOKIE >> 16)
    mask = struct.pack(">I", COOKIE)
    ip = ".".join(str(b ^ m) for b, m in zip(v[4:8], mask))
    return f"{ip}:{port}"



def parse(data):
    if len(data) < 20:
        return 0, {}
    mtype = struct.unpack(">H", data[:2])[0]
    blen = struct.unpack(">H", data[2:4])[0]
    off, out = 20, {}
    end = min(len(data), 20 + blen)
    while off + 4 <= end:
        t, l = struct.unpack(">HH", data[off:off + 4])
        v = data[off + 4:off + 4 + l]
        if t == ERROR_CODE and l >= 4:
            out["code"] = v[2] * 100 + v[3]
            out["reason"] = v[4:].decode(errors="replace")
        elif t in (REALM, NONCE, SOFTWARE):
            out[{REALM: "realm", NONCE: "nonce", SOFTWARE: "server"}[t]] = \
                v.decode(errors="replace")
        elif t == XOR_RELAY:
            out["relay"] = xor_addr(v)
        elif t == XOR_MAPPED:
            out["mapped"] = xor_addr(v)
        elif t == LIFETIME and l >= 4:
            out["lifetime"] = struct.unpack(">I", v[:4])[0]
        off += 4 + l + ((4 - l % 4) % 4)
    return mtype, out


def probe(tcp=False):
    label = "tcp" if tcp else "udp"
    tid = os.urandom(12)
    # Один сокет на весь цикл: nonce проверяется по транспортному адресу.
    if tcp:
        s = socket.create_connection((HOST, PORT), timeout=8)
        send = lambda b: s.sendall(b)
        recv = lambda: s.recv(4096)
    else:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(8)
        send = lambda b: s.sendto(b, (HOST, PORT))
        recv = lambda: s.recv(4096)
    plain = attr(USERNAME, U) + attr(REQ_TRANSPORT, b"\x11\x00\x00\x00")
    send(build(REQUEST, tid, plain))
    mtype, a = parse(recv())
    print(f"  {label} шаг 1 (без MESSAGE-INTEGRITY): type=0x{mtype:04x} "
          f"code={a.get('code')} realm={a.get('realm')} "
          f"nonce={'есть' if a.get('nonce') else 'нет'} server={a.get('server')}")
    if not a.get("realm") or not a.get("nonce"):
        print(f"  {label}: realm/nonce не получены — дальше не идём")
        s.close()
        return False
    key = hashlib.md5(f"{U}:{a['realm']}:{P}".encode()).digest()
    ok = False
    nonce = a["nonce"]
    for attempt in range(1, 4):
        body = plain + attr(REALM, a["realm"]) + attr(NONCE, nonce)
        send(build(REQUEST, os.urandom(12), body, key=key))
        mtype2, r = parse(recv())
        print(f"  {label} шаг 2 попытка {attempt}: type=0x{mtype2:04x} "
              f"code={r.get('code')} reason={r.get('reason')} relay={r.get('relay')} "
              f"mapped={r.get('mapped')} lifetime={r.get('lifetime')}")
        ok = mtype2 == ALLOCATE_SUCCESS and bool(r.get("relay"))
        if r.get("code") == 438 and r.get("nonce"):
            nonce = r["nonce"]  # протух — берём новый и повторяем
            continue
        break
    s.close()
    return ok


if not U or not P:
    raise SystemExit("TU/TP не заданы — запустите через scripts/turn-probe.sh")
print(f"TURN Allocate на {HOST}:{PORT} из внешней сети (метка {U.split(':')[-1][:8]}…, "
      f"срок {U.split(':')[0]}):")
raise SystemExit(0 if probe(tcp=False) else 1)
