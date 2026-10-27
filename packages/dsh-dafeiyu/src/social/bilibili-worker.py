"""Pinned SDK worker. Private credentials never cross this JSONL protocol.

This is not the public seven-tool browsing MCP. It has its own account,
explicit owner-reviewed dispatch proof, and no background message listener.
"""
import asyncio
import base64
import io
import contextlib
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import uuid
import time
from urllib.parse import urlparse, parse_qs


def require(condition, code):
    if not condition:
        raise ValueError(code)


class WebQrLogin:
    """Web QR auth reads only this login response's Set-Cookie headers.

    Compatibility finding: kukemc/bili-cli, commands/auth.py, commit
    e603eeb86cc0c43c362d7d0a3be6327dba54c375 (MIT). The archived SDK only
    parses redirect query parameters and can miss current header-only cookies.
    This adapter never imports browser cookies or follows a credential URL.
    """
    GENERATE = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
    POLL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"
    NAMES = {"SESSDATA", "bili_jct", "DedeUserID", "buvid3", "buvid4"}

    def __init__(self, directory, credential_class, headers=None, client_factory=None, clock=time.time, qr_encoder=None):
        self.directory = Path(directory)
        self.file = self.directory / "login-pending.private.json"
        self.credential_class = credential_class
        self.headers = {k: v for k, v in (headers or {}).items() if k in ("User-Agent", "Referer")}
        self.headers["Accept"] = "application/json"
        self.client_factory = client_factory
        self.clock = clock
        self.qr_encoder = qr_encoder

    async def request(self, url, params):
        if self.client_factory is None:
            import httpx
            factory = httpx.AsyncClient
        else:
            factory = self.client_factory
        try:
            async with factory(headers=self.headers, timeout=15, follow_redirects=False, trust_env=False) as client:
                response = await client.get(url, params=params)
                require(response.status_code not in (403, 412, 429), "RISK_CONTROL")
                require(response.status_code == 200, "LOGIN_REQUEST_FAILED")
                require(len(response.content) <= 65536, "LOGIN_RESPONSE_INVALID")
                value = response.json()
                require(isinstance(value, dict), "LOGIN_RESPONSE_INVALID")
                require(value.get("code") not in (-352, -412, -799, -509), "RISK_CONTROL")
                require(type(value.get("code")) is int and value["code"] == 0 and isinstance(value.get("data"), dict), "LOGIN_RESPONSE_INVALID")
                cookies = {c.name: c.value for c in client.cookies.jar if c.name in self.NAMES
                           and c.domain.lstrip(".").lower() in ("bilibili.com", "passport.bilibili.com")}
                return value["data"], cookies
        except ValueError as error:
            if re.fullmatch(r"[A-Z_]{3,64}", str(error)):
                raise
            raise ValueError("LOGIN_RESPONSE_INVALID") from None
        except Exception:
            raise ValueError("LOGIN_REQUEST_FAILED") from None

    def pending(self):
        try:
            stat = self.file.lstat()
        except FileNotFoundError:
            return None
        require(self.file.is_file() and not self.file.is_symlink() and stat.st_size <= 16384, "INVALID_CREDENTIAL")
        value = json.loads(self.file.read_text())
        require(isinstance(value, dict) and set(value) == {"version", "sessionId", "key", "url", "createdAt"}
                and value["version"] == 1 and isinstance(value["createdAt"], (int, float))
                and isinstance(value["key"], str) and re.fullmatch(r"[A-Za-z0-9_-]{16,200}", value["key"])
                and isinstance(value["sessionId"], str), "INVALID_CREDENTIAL")
        return value

    async def start(self, session):
        require(isinstance(session, str) and str(uuid.UUID(session)) == session, "INVALID_REQUEST")
        previous = self.pending()
        require(not previous or self.clock() - previous["createdAt"] >= 180, "LOGIN_PENDING")
        data, _ = await self.request(self.GENERATE, {"source": "main-fe-header"})
        link, key = data.get("url"), data.get("qrcode_key")
        parsed = urlparse(link or "")
        require(parsed.scheme == "https" and parsed.hostname == "passport.bilibili.com" and not parsed.username
                and not parsed.password and not parsed.fragment and not parsed.port and len(link) <= 2000
                and isinstance(key, str) and re.fullmatch(r"[A-Za-z0-9_-]{16,200}", key), "LOGIN_RESPONSE_INVALID")
        if self.qr_encoder:
            image = self.qr_encoder(link)
        else:
            import qrcode
            buffer = io.BytesIO()
            qrcode.make(link).save(buffer, format="PNG")
            image = buffer.getvalue()
        require(isinstance(image, bytes) and image.startswith(b"\x89PNG\r\n\x1a\n") and len(image) < 1024 * 1024, "INVALID_QR")
        record = {"version": 1, "sessionId": session, "key": key, "url": link, "createdAt": self.clock()}
        tmp = self.directory / ("login-pending-" + uuid.uuid4().hex + ".tmp")
        try:
            with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as out:
                json.dump(record, out)
                out.flush()
                os.fsync(out.fileno())
            os.replace(tmp, self.file)
        finally:
            tmp.unlink(missing_ok=True)
        return {"state": "login-pending", "method": "qr", "sessionId": session,
                "image": {"mime": "image/png", "base64": base64.b64encode(image).decode()}}

    async def poll(self, session):
        pending = self.pending()
        require(pending and pending["sessionId"] == session, "LOGIN_SESSION_MISMATCH")
        if self.clock() - pending["createdAt"] >= 180:
            return {"loggedIn": False, "state": "expired"}, None
        data, cookies = await self.request(self.POLL, {"qrcode_key": pending["key"]})
        code = data.get("code")
        if code in (86101, 86090):
            return {"loggedIn": False, "state": "login-pending", "scanned": code == 86090}, None
        if code == 86038:
            return {"loggedIn": False, "state": "expired"}, None
        require(type(code) is int and code == 0, "LOGIN_STATUS_UNKNOWN")
        # Older responses used a redirect URL. Parse it locally, never fetch it.
        legacy = {}
        link = data.get("url")
        if link:
            parsed = urlparse(link)
            require(parsed.scheme == "https" and parsed.hostname in ("passport.bilibili.com", "passport.biligame.com")
                    and not parsed.username and not parsed.password, "LOGIN_RESPONSE_INVALID")
            legacy = parse_qs(parsed.query, max_num_fields=32)
        def pick(name):
            values = legacy.get(name, [])
            require(len(values) <= 1, "LOGIN_RESPONSE_INVALID")
            return cookies.get(name) or (values[0] if values else None)
        values = {"sessdata": pick("SESSDATA"), "bili_jct": pick("bili_jct"), "dedeuserid": pick("DedeUserID"),
                  "buvid3": cookies.get("buvid3"), "ac_time_value": data.get("refresh_token")}
        require(values["sessdata"] and values["bili_jct"], "INCOMPLETE_CREDENTIAL")
        return {"loggedIn": True}, self.credential_class(**values)

    def clear(self):
        self.file.unlink(missing_ok=True)


class Worker:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        require(not Path(directory).is_symlink(), "INVALID_STORAGE")
        os.chmod(self.directory, 0o700)
        self.file = self.directory / "credential.private.json"
        self.sdk = None
        tempfile.tempdir = str(self.directory)

    def load_sdk(self):
        if self.sdk is not None:
            return
        require(importlib.metadata.version("bilibili-api-python") == "17.4.2", "SDK_VERSION_MISMATCH")
        from bilibili_api import Credential, user, comment, video, session, search, video_uploader
        from bilibili_api.utils.network import request_settings, HEADERS
        # Exactly one attempt: do not let SDK signature retries repeat a write.
        request_settings.set_wbi_retry_times(1)
        self.sdk = dict(Credential=Credential, user=user, comment=comment,
                        video=video, session=session, search=search, uploader=video_uploader)
        self.web_login = WebQrLogin(self.directory, Credential, HEADERS)

    def credential(self):
        require(self.file.exists() and not self.file.is_symlink() and self.file.stat().st_size < 32768, "LOGIN_REQUIRED")
        value = json.loads(self.file.read_text())
        require(isinstance(value, dict) and set(value) <= {"sessdata", "bili_jct", "buvid3", "dedeuserid", "ac_time_value"}, "INVALID_CREDENTIAL")
        return self.sdk["Credential"](**value)

    def save_credential(self, credential):
        value = {key: getattr(credential, key, None) for key in ("sessdata", "bili_jct", "buvid3", "dedeuserid", "ac_time_value")}
        require(value["sessdata"] and value["bili_jct"] and value["dedeuserid"], "INCOMPLETE_CREDENTIAL")
        tmp = self.directory / ("credential-" + uuid.uuid4().hex + ".tmp")
        with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as handle:
            json.dump(value, handle)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.replace(tmp, self.file)
        finally:
            tmp.unlink(missing_ok=True)

    async def account(self):
        if not self.file.exists():
            return {"loggedIn": False, "state": "login-pending"}
        result = await self.sdk["user"].get_self_info(self.credential())
        require(str(result.get("mid", "")).isdigit(), "IDENTITY_UNAVAILABLE")
        return {"loggedIn": True, "accountId": str(result["mid"]), "name": str(result.get("name", ""))[:100]}

    async def start_login(self, request):
        return await self.web_login.start(request["sessionId"])

    async def check_login(self, request):
        if self.web_login.pending() is None:
            return await self.account()
        state, credential = await self.web_login.poll(request["sessionId"])
        if credential is None:
            return state
        if not credential.dedeuserid:
            own = await self.sdk["user"].get_self_info(credential)
            require(str(own.get("mid", "")).isdigit(), "IDENTITY_UNAVAILABLE")
            credential.dedeuserid = str(own["mid"])
        self.save_credential(credential)
        self.web_login.clear()
        return await self.account()

    async def video_target(self, target, credential):
        text = str(target)
        match = re.fullmatch(r"(?:https://www\.bilibili\.com/video/)?(BV[A-Za-z0-9]{10})/?", text)
        if match:
            return self.sdk["video"].Video(bvid=match[1], credential=credential)
        require(re.fullmatch(r"(?:av)?[1-9][0-9]{0,19}", text), "INVALID_TARGET")
        return self.sdk["video"].Video(aid=int(text.removeprefix("av")), credential=credential)

    @staticmethod
    def number(value):
        require(re.fullmatch(r"[1-9][0-9]{0,19}", str(value)), "INVALID_TARGET")
        return int(value)

    @staticmethod
    def text(value, maximum=2000):
        return re.sub(r"<[^>]{0,300}>", "", str(value or ""))[:maximum]

    async def read(self, request):
        require(not request.get("cursor"), "OPERATION_UNAVAILABLE")
        cred = self.credential()
        owner = await self.account()
        operation, limit = request["operation"], min(int(request.get("limit", 10)), 20)
        user, comments, sessions = self.sdk["user"], self.sdk["comment"], self.sdk["session"]
        target = request.get("target")
        items = []
        if operation == "profile":
            return {"ok": True, "accountId": owner["accountId"], "profile": owner}
        if operation == "posts":
            result = await user.User(int(owner["accountId"]), credential=cred).get_videos(pn=1)
            for row in result.get("list", {}).get("vlist", [])[:limit]:
                items.append({"id": str(row.get("aid", "")), "bvid": row.get("bvid"), "title": self.text(row.get("title"), 300)})
        elif operation == "search":
            search = self.sdk["search"]
            result = await search.search_by_type(request["query"], search_type=search.SearchObjectType.VIDEO)
            for row in result.get("result", [])[:limit]:
                items.append({"id": str(row.get("aid", "")), "bvid": row.get("bvid"), "title": self.text(row.get("title"), 300)})
        elif operation == "comments":
            resource = await self.video_target(target, cred)
            result = await comments.get_comments(resource.get_aid(), comments.CommentResourceType.VIDEO, page_index=1, credential=cred)
            for row in result.get("replies", [])[:limit]:
                items.append({"id": str(row.get("rpid_str", row.get("rpid", ""))), "rootId": str(row.get("root") or row.get("rpid_str", row.get("rpid", ""))),
                              "text": self.text(row.get("content", {}).get("message")),
                              "authorId": str(row.get("mid", "")), "authorName": self.text(row.get("member", {}).get("uname"), 100)})
        elif operation in ("replies", "notifications"):
            result = await sessions.get_replies(cred)
            for row in result.get("items", [])[:limit]:
                item = row.get("item", {})
                items.append({"id": str(row.get("id", "")), "text": self.text(item.get("source_content", item.get("title"))),
                              "authorId": str(row.get("user", {}).get("mid", "")), "target": self.text(item.get("uri"), 1000)})
        elif operation == "inbox":
            result = await sessions.get_sessions(cred, session_type=1)
            for row in result.get("session_list", [])[:limit]:
                items.append({"target": str(row.get("talker_id", "")), "unread": min(int(row.get("unread_count", 0)), 99999)})
        elif operation == "messages":
            talker = self.number(target)
            result = await sessions.fetch_session_msgs(talker, cred)
            for row in result.get("messages", [])[:limit]:
                body = row.get("content", "")
                try:
                    body = json.loads(body).get("content", "[非文字消息]")
                except (ValueError, TypeError, AttributeError):
                    body = "[非文字消息]"
                items.append({"id": str(row.get("msg_key", "")), "from": str(row.get("sender_uid", "")),
                              "to": str(row.get("receiver_id", "")), "text": self.text(body), "timestamp": row.get("timestamp")})
        else:
            raise ValueError("OPERATION_UNAVAILABLE")
        return {"ok": True, "accountId": owner["accountId"], "operation": operation, "items": items}

    async def execute(self, envelope):
        request = envelope["request"]
        owner = await self.account()
        require(owner["accountId"] == envelope["accountId"], "ACCOUNT_MISMATCH")
        operation = request["operation"]
        require(operation in ("comment", "reply", "message", "video"), "OPERATION_UNAVAILABLE")
        if operation == "video":
            media = envelope["media"]
            for entry in (media, media.get("cover")):
                require(isinstance(entry, dict), "INVALID_MEDIA")
                file = Path(entry["path"])
                require(file.is_absolute() and not file.is_symlink() and file.is_file(), "MEDIA_CHANGED")
                with file.open("rb") as handle:
                    fingerprint = hashlib.file_digest(handle, "sha256").hexdigest()
                require(file.stat().st_size == entry["bytes"] and fingerprint == entry["sha256"], "MEDIA_CHANGED")
        claim = Path(envelope["claimFile"])
        require(claim.parent.resolve() == self.directory and re.fullmatch(r"[a-f0-9-]{36}\.once", claim.name), "INVALID_CLAIM")
        # Claim inside the actual worker, before the first external mutation.
        fd = os.open(claim, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(envelope["approvalDigest"])
            handle.flush()
            os.fsync(handle.fileno())
        cred = self.credential()
        if operation in ("comment", "reply"):
            target = await self.video_target(request["target"], cred)
            root = self.number(request["rootId"]) if operation == "reply" else None
            parent = self.number(request["parentId"]) if operation == "reply" else None
            response = await self.sdk["comment"].send_comment(request["text"], target.get_aid(),
                        self.sdk["comment"].CommentResourceType.VIDEO, root=root, parent=parent, credential=cred)
            identifier = str(response.get("rpid_str", response.get("rpid", response.get("reply", {}).get("rpid", ""))))
        elif operation == "message":
            response = await self.sdk["session"].send_msg(cred, self.number(request["target"]),
                        self.sdk["session"].EventType.TEXT, request["text"])
            identifier = str(response.get("msg_key", ""))
        else:
            require(request.get("declaration") == "none", "DECLARATION_BINDING_REQUIRED")
            require(request.get("cover") and request.get("tags") and str(request.get("category", "")).isdigit(), "VIDEO_METADATA_REQUIRED")
            uploader = self.sdk["uploader"]
            meta = uploader.VideoMeta(tid=int(request["category"]), title=request["title"], desc=request.get("text", ""),
                                      cover=request["cover"], tags=request["tags"])
            page = uploader.VideoUploaderPage(envelope["media"]["path"], title=request["title"])
            response = await uploader.VideoUploader([page], meta, cred).start()
            identifier = str(response.get("bvid", response.get("aid", "")))
        require(re.fullmatch(r"[A-Za-z0-9_:-]{1,150}", identifier), "RECEIPT_UNAVAILABLE")
        return {"ok": True, "id": identifier, "accountId": owner["accountId"], "operation": operation,
                "target": request.get("target", ""), "parentId": request.get("parentId", ""), "rootId": request.get("rootId", ""),
                "contentDigest": envelope["contentDigest"], "operationId": envelope["operationId"], "status": "submitted"}

    async def handle(self, message):
        self.load_sdk()
        method = message["method"]
        if method == "login/start":
            return await self.start_login(message["input"])
        if method == "login/check":
            return await self.check_login(message["input"])
        if method == "account":
            return await self.account()
        if method == "read":
            return await self.read(message["input"])
        if method == "execute":
            return await self.execute(message["input"])
        raise ValueError("INVALID_METHOD")


async def main():
    require(len(sys.argv) == 2 and Path(sys.argv[1]).is_absolute(), "INVALID_STORAGE")
    worker = Worker(sys.argv[1])
    while True:
        line = await asyncio.to_thread(sys.stdin.buffer.readline, 65537)
        if not line:
            return
        identifier = None
        try:
            require(len(line) <= 65536 and line.endswith(b"\n"), "INVALID_REQUEST")
            value = json.loads(line)
            identifier = value.get("id")
            require(isinstance(identifier, str) and re.fullmatch(r"[a-f0-9-]{36}", identifier), "INVALID_REQUEST")
            with contextlib.redirect_stdout(sys.stderr):
                result = await asyncio.wait_for(worker.handle(value), timeout=600)
            reply = {"id": identifier, "ok": True, "result": result, "sdkVersion": "17.4.2"}
        except Exception as error:
            risk = getattr(error, "code", None) in (-352, -412, -799, -509) or getattr(error, "status", None) in (403, 412, 429)
            code = "RISK_CONTROL" if risk else str(error) if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]{3,64}", str(error)) else "PLATFORM_REQUEST_FAILED"
            reply = {"id": identifier, "ok": False, "code": code}
        sys.stdout.write(json.dumps(reply, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    asyncio.run(main())
