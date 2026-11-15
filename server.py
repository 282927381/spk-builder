#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
server.py — SPK 构建台(本地 Web 服务)。

启动后访问 http://127.0.0.1:8800
"""
import glob
import hashlib
import io
import json
import os
import re
import shutil
import threading
import traceback
import urllib.parse
import uuid
import webbrowser
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import builders
import spkpack

BASE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(BASE, "web")
OUTPUT_DIR = os.path.join(BASE, "output")
os.makedirs(OUTPUT_DIR, exist_ok=True)

JOBS = {}
LOCK = threading.Lock()

CTYPES = {
    "html": "text/html",
    "js": "application/javascript",
    "css": "text/css",
    "svg": "image/svg+xml",
    "png": "image/png",
    "ico": "image/x-icon",
    "json": "application/json",
}


def start_job(fn):
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "status": "running", "log": [], "result": None, "error": None}
    with LOCK:
        JOBS[jid] = job

    def _run():
        def log(m):
            with LOCK:
                job["log"].append(m)
        try:
            job["result"] = fn(log)
            job["status"] = "done"
        except Exception as e:  # noqa: BLE001
            with LOCK:
                job["log"].append(traceback.format_exc())
                job["error"] = str(e)
                job["status"] = "error"

    threading.Thread(target=_run, daemon=True).start()
    return jid


def run_build(cfg, log):
    tools = builders.detect()
    name = (cfg.get("name") or "").strip()
    version = (cfg.get("version") or "").strip()
    if not name or not version:
        raise RuntimeError("套件名称(name)和版本(version)不能为空")

    mode = cfg.get("mode", "prebuilt")
    archs = cfg.get("archs") or ["noarch"]
    source_dir = (cfg.get("source_dir") or "").strip()
    binary = (cfg.get("binary_name") or name).strip()
    start_cmd = (cfg.get("start_cmd") or "").strip() or None
    stop_cmd = (cfg.get("stop_cmd") or "").strip() or None
    run_as = (cfg.get("run_as") or "root").strip()
    run_user = (cfg.get("run_user") or "").strip() or None

    if mode not in ("prebuilt", "spksrc") and (not source_dir or not os.path.isdir(source_dir)):
        raise RuntimeError("源码目录不存在: %s" % source_dir)

    if mode == "go" and not tools["go"]:
        raise RuntimeError("未检测到 Go 工具链。请安装 Go 后重试(见 README)。")
    if mode == "docker" and not tools["docker"]:
        raise RuntimeError("未检测到 Docker。请先安装 Docker Desktop(需启用 Linux 容器)。")
    if mode == "local" and not (cfg.get("local_cmd") or "").strip():
        raise RuntimeError("本地构建模式需要填写构建命令(local_cmd)。")

    info_fields = {
        "displayname": cfg.get("displayname"),
        "displayname_chs": cfg.get("displayname_chs"),
        "description": cfg.get("description"),
        "description_chs": cfg.get("description_chs"),
        "maintainer": cfg.get("maintainer") or "Unknown",
        "maintainer_url": cfg.get("maintainer_url"),
        "distributor": cfg.get("distributor"),
        "distributor_url": cfg.get("distributor_url"),
        "support_url": cfg.get("support_url"),
        "beta": cfg.get("beta") or "no",
    }
    if cfg.get("os_min_ver"):
        info_fields["os_min_ver"] = cfg["os_min_ver"]

    # Web 端口 / DSM UI 集成字段(决定套件中心是否显示「打开」按钮):
    # 1) 优先采用前端显式传入的值;2) prebuilt 二次打包时自动从解包目录的 INFO 保留。
    for f in spkpack.WEB_UI_FIELDS:
        if cfg.get(f):
            info_fields[f] = cfg[f]
    if mode == "prebuilt" and source_dir and os.path.isfile(os.path.join(source_dir, "INFO")):
        try:
            with open(os.path.join(source_dir, "INFO"), "r", encoding="utf-8", errors="replace") as fh:
                imported = spkpack.parse_info(fh.read())
            for f in spkpack.WEB_UI_FIELDS:
                if imported.get(f) and f not in info_fields:
                    info_fields[f] = imported[f]
        except Exception:  # noqa: BLE001
            pass

    out_root = os.path.join(OUTPUT_DIR, "%s-%s" % (name, version))
    os.makedirs(out_root, exist_ok=True)

    cfg["_go"] = tools["go"]
    cfg["_docker"] = tools["docker"]

    scripts_dir = None
    icons_dir = None
    if source_dir and os.path.isdir(source_dir):
        s = os.path.join(source_dir, "scripts")
        if os.path.isdir(s):
            scripts_dir = s
        icons_dir = source_dir

    results = []
    for arch in archs:
        log("========== 构建架构: %s ==========" % arch)
        build_dir = os.path.join(out_root, "build", arch)
        os.makedirs(build_dir, exist_ok=True)
        target_dir = build_dir

        if mode == "go":
            out_bin = os.path.join(build_dir, "bin", binary)
            builders.build_go(cfg, arch, out_bin, log)
        elif mode == "docker":
            out_bin = os.path.join(build_dir, "bin", binary)
            builders.build_docker(cfg, arch, out_bin, log)
        elif mode == "local":
            out_bin = os.path.join(build_dir, "bin", binary)
            builders.build_local(cfg, arch, out_bin, log)
        elif mode == "prebuilt":
            base = source_dir
            if arch != "noarch":
                cand = os.path.join(base, arch)
                if os.path.isdir(cand):
                    base = cand
            t = os.path.join(base, "target")
            target_dir = t if os.path.isdir(t) else base
        elif mode == "spksrc":
            builders.build_spksrc(cfg, arch, build_dir, log)
            spks = sorted(glob.glob(os.path.join(build_dir, "*.spk")))
            if not spks:
                raise RuntimeError("spksrc 未产出 .spk(请检查上方构建日志)")
            for s in spks:
                dest = os.path.join(out_root, os.path.basename(s))
                if os.path.abspath(s) != os.path.abspath(dest):
                    shutil.move(s, dest)
                rel = os.path.relpath(dest, OUTPUT_DIR).replace("\\", "/")
                results.append({"arch": arch, "filename": os.path.basename(dest), "url": "/output/" + rel})
                log("生成完成: %s" % dest)
            continue
        else:
            raise RuntimeError("未知构建方式: " + mode)

        if not os.path.isdir(target_dir):
            raise RuntimeError("目标目录不存在: " + target_dir)

        extra = None
        if mode == "prebuilt" and source_dir and os.path.isdir(os.path.join(source_dir, "target")):
            extra = source_dir
        spk = spkpack.build_spk(
            out_root, name=name, version=version, arch=arch,
            info_fields=info_fields, target_dir=target_dir,
            scripts_dir=scripts_dir, icons_dir=icons_dir,
            binary=binary, start_cmd=start_cmd, stop_cmd=stop_cmd,
            extra_dir=extra, run_as=run_as, run_user=run_user,
        )
        rel = os.path.relpath(spk, OUTPUT_DIR).replace("\\", "/")
        results.append({"arch": arch, "filename": os.path.basename(spk), "url": "/output/" + rel})
        log("生成完成: %s" % spk)

    log("全部完成,共生成 %d 个 .spk" % len(results))
    return {"output_dir": out_root, "spks": results}


def run_batch_build(items, log):
    """批量构建:items 为完整构建配置列表,逐个调用 run_build。
    单个包失败不影响后续,最终汇总成功/失败结果。"""
    results = []
    total = len(items)
    for idx, item in enumerate(items, 1):
        name = (item.get("name") or "").strip()
        version = (item.get("version") or "").strip()
        label = name + ((" v" + version) if version else "") or ("#%d" % idx)
        log("")
        log("=" * 62)
        log("【%d/%d】构建套件: %s" % (idx, total, label))
        log("=" * 62)
        try:
            r = run_build(item, log)
            r["ok"] = True
            r["label"] = label
            r["name"] = name or ("pkg-%d" % idx)
            results.append(r)
        except Exception as e:  # noqa: BLE001
            log("❌ 套件 %s 构建失败: %s" % (label, e))
            results.append({"ok": False, "label": label, "error": str(e)})

    ok_count = sum(1 for r in results if r.get("ok"))
    log("")
    log("#" * 62)
    log("批量构建完成: 成功 %d / 失败 %d / 共 %d" % (ok_count, total - ok_count, total))
    log("#" * 62)
    return {"items": results, "ok": ok_count, "fail": total - ok_count, "total": total}


def do_import_from_path(path, filename=None, log=None):
    logs = []

    def _log(m):
        logs.append(m)
        if log:
            log(m)

    if not os.path.isfile(path):
        raise RuntimeError("文件不存在: %s" % path)
    stem = filename or path
    stem = os.path.splitext(os.path.basename(str(stem).replace("\\", "/")))[0]
    base = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", stem).rstrip(" .") or "package"
    if len(base) > 64:
        suffix = hashlib.sha256(stem.encode("utf-8", "replace")).hexdigest()[:10]
        base = base[:64] + "-" + suffix
    out_dir = os.path.join(OUTPUT_DIR, "_imported", base)
    if os.path.isdir(out_dir):
        spkpack.rmtree(out_dir)
    res = spkpack.unpack_spk(path, out_dir, log=_log)
    res["dir"] = out_dir
    res["name"] = res["info"].get("package", "")
    res["version"] = res["info"].get("version", "")
    res["arch"] = spkpack.map_arch(res["info"].get("arch", ""))
    _log("套件信息: %s v%s (架构: %s)" % (
        res["name"] or "(未知)", res["version"] or "-", ",".join(res["arch"])))
    priv_path = os.path.join(out_dir, "conf", "privilege")
    if os.path.isfile(priv_path):
        try:
            with open(priv_path, "r", encoding="utf-8") as fh:
                p = json.loads(fh.read())
            res["run_as"] = (p.get("defaults") or {}).get("run-as", "")
            res["run_user"] = p.get("username", "")
            _log("运行身份: %s (用户: %s)" % (res["run_as"], res["run_user"] or "-"))
        except Exception:
            pass
    res["log"] = logs
    return res


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False))

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/status":
            return self._json({"tools": builders.detect(), "output_dir": OUTPUT_DIR})
        if path == "/api/changelog":
            try:
                p = os.path.join(BASE, "更新日志.txt")
                raw = open(p, "rb").read()
                try:
                    content = raw.decode("utf-8")
                except UnicodeDecodeError:
                    content = raw.decode("gbk", errors="replace")
                return self._json({"content": content})
            except Exception as e:  # noqa: BLE001
                return self._json({"error": str(e)}, 500)
        if path.startswith("/api/jobs/"):
            jid = path.split("/")[-1]
            job = JOBS.get(jid)
            if not job:
                return self._json({"error": "not found"}, 404)
            return self._json(job)
        if path.startswith("/output/"):
            rel = path[len("/output/"):]
            fpath = os.path.abspath(os.path.join(OUTPUT_DIR, rel))
            root = os.path.abspath(OUTPUT_DIR)
            if fpath.startswith(root) and os.path.isfile(fpath):
                data = open(fpath, "rb").read()
                fname = os.path.basename(fpath)
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Disposition", 'attachment; filename="%s"' % fname)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            return self._send(404, "not found", "text/plain")
        # 静态文件
        if path == "/":
            path = "/index.html"
        fpath = os.path.normpath(os.path.join(WEB, path.lstrip("/")))
        if fpath.startswith(WEB) and os.path.isfile(fpath):
            ext = fpath.rsplit(".", 1)[-1].lower() if "." in fpath else "html"
            data = open(fpath, "rb").read()
            return self._send(200, data, CTYPES.get(ext, "application/octet-stream"))
        self._send(404, "not found", "text/plain")

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/build":
            try:
                n = int(self.headers.get("Content-Length", 0))
                cfg = json.loads(self.rfile.read(n) or b"{}")
            except Exception as e:  # noqa: BLE001
                return self._json({"error": "请求体解析失败: %s" % e}, 400)
            jid = start_job(lambda log: run_build(cfg, log))
            return self._json({"job_id": jid})
        if path == "/api/batch-build":
            try:
                n = int(self.headers.get("Content-Length", 0))
                cfg = json.loads(self.rfile.read(n) or b"{}")
            except Exception as e:  # noqa: BLE001
                return self._json({"error": "请求体解析失败: %s" % e}, 400)
            items = cfg.get("items") or []
            if not items:
                return self._json({"error": "批量任务列表为空"}, 400)
            jid = start_job(lambda log: run_batch_build(items, log))
            return self._json({"job_id": jid})
        if path == "/api/batch-download":
            try:
                n = int(self.headers.get("Content-Length", 0))
                cfg = json.loads(self.rfile.read(n) or b"{}")
            except Exception as e:  # noqa: BLE001
                return self._json({"error": "请求体解析失败: %s" % e}, 400)
            files = cfg.get("files") or []
            if not files:
                return self._json({"error": "下载列表为空"}, 400)
            buf = io.BytesIO()
            added = 0
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                for f in files:
                    rel = str(f.get("path") or f.get("url") or "").lstrip("/")
                    if rel.startswith("output/"):
                        rel = rel[len("output/"):]
                    fpath = os.path.abspath(os.path.join(OUTPUT_DIR, rel))
                    if not fpath.startswith(os.path.abspath(OUTPUT_DIR)) or not os.path.isfile(fpath):
                        continue
                    folder = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(f.get("name") or "package")).strip() or "package"
                    arcname = "%s-dsm7/%s" % (folder, os.path.basename(fpath))
                    zf.write(fpath, arcname)
                    added += 1
            if added == 0:
                return self._json({"error": "没有可下载的文件"}, 400)
            data = buf.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Disposition", 'attachment; filename="spk-packages-dsm7.zip"')
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return
        if path == "/api/import":
            ctype = self.headers.get("Content-Type", "")
            n = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(n)
            try:
                if ctype.startswith("application/json"):
                    cfg = json.loads(body or b"{}")
                    p = (cfg.get("path") or "").strip()
                    if not p:
                        return self._json({"error": "请提供 .spk 路径(path)"}, 400)
                    res = do_import_from_path(p)
                else:
                    fname = "upload.spk"
                    if "?" in self.path:
                        params = urllib.parse.parse_qs(self.path.split("?", 1)[1])
                        if params.get("filename"):
                            fname = os.path.basename(params["filename"][0].replace("\\", "/"))
                    if not fname.lower().endswith(".spk"):
                        fname += ".spk"
                    upload_dir = os.path.join(BASE, "uploads")
                    os.makedirs(upload_dir, exist_ok=True)
                    # 原始文件名仅用于结果目录命名;临时文件使用短名称以规避 Windows 长路径限制。
                    tmp = os.path.join(upload_dir, "upload-%s.spk" % uuid.uuid4().hex)
                    try:
                        with open(tmp, "wb") as fh:
                            fh.write(body)
                        res = do_import_from_path(tmp, filename=fname)
                    finally:
                        try:
                            os.remove(tmp)
                        except OSError:
                            pass
                return self._json(res)
            except Exception as e:  # noqa: BLE001
                return self._json({"error": str(e)}, 500)
        if path == "/api/import-job":
            ctype = self.headers.get("Content-Type", "")
            n = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(n)
            try:
                if ctype.startswith("application/json"):
                    cfg = json.loads(body or b"{}")
                    p = (cfg.get("path") or "").strip()
                    if not p:
                        return self._json({"error": "请提供 .spk 路径(path)"}, 400)
                    jid = start_job(lambda log: do_import_from_path(p, log=log))
                    return self._json({"job_id": jid})
                # 文件上传:临时文件在 job 执行完毕后再清理
                fname = "upload.spk"
                if "?" in self.path:
                    params = urllib.parse.parse_qs(self.path.split("?", 1)[1])
                    if params.get("filename"):
                        fname = os.path.basename(params["filename"][0].replace("\\", "/"))
                if not fname.lower().endswith(".spk"):
                    fname += ".spk"
                upload_dir = os.path.join(BASE, "uploads")
                os.makedirs(upload_dir, exist_ok=True)
                tmp = os.path.join(upload_dir, "upload-%s.spk" % uuid.uuid4().hex)
                with open(tmp, "wb") as fh:
                    fh.write(body)

                def _run(log):
                    try:
                        return do_import_from_path(tmp, filename=fname, log=log)
                    finally:
                        try:
                            os.remove(tmp)
                        except OSError:
                            pass

                jid = start_job(_run)
                return self._json({"job_id": jid})
            except Exception as e:  # noqa: BLE001
                return self._json({"error": str(e)}, 500)
        self._json({"error": "not found"}, 404)

    def log_message(self, *args):
        pass


def port_in_use(port):
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.4)
    try:
        s.connect(("127.0.0.1", port))
        s.close()
        return True
    except OSError:
        return False


def main():
    port = int(os.environ.get("SPK_BUILDER_PORT", "8800"))
    if port_in_use(port):
        print("端口 %d 已被占用,可能已有 SPK 构建台在运行。" % port)
        print("请直接打开 http://127.0.0.1:%d 使用现有实例。" % port)
        if os.environ.get("SPK_BUILDER_NO_BROWSER") != "1":
            webbrowser.open("http://127.0.0.1:%d" % port)
        return
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("=" * 46)
    print("  SPK 构建台已启动")
    print("  请用浏览器打开: http://127.0.0.1:%d" % port)
    print("  按 Ctrl+C 停止")
    print("=" * 46)
    if os.environ.get("SPK_BUILDER_NO_BROWSER") != "1":
        def _open():
            import time
            time.sleep(1.0)
            webbrowser.open("http://127.0.0.1:%d" % port)
        threading.Thread(target=_open, daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
