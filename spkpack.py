#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
spkpack.py — 生成 Synology .spk 安装包的核心模块(纯标准库,可选 Pillow 画图标)。

一个 .spk 的结构:
  外层 = 不压缩的 tar 归档,内含:
    INFO               元信息(key="value" 文本)
    package.tgz        gzip tar,装到 /var/packages/<包名>/target/
    scripts/           生命周期脚本(preinst/postinst/.../start-stop-status)
    PACKAGE_ICON.PNG / PACKAGE_ICON_256.PNG
    (可选) conf/  WIZARD_UIFILES/  LICENSE
"""
import json
import os
import shutil
import tarfile

# 哪些文件需要 0755(可执行)
EXEC_NAMES = {"start-stop-status", "run", "service"}
EXEC_EXTS = {"", ".sh", ".py", ".pl", ".bash", ".cgi", ".rb", ".php"}


def _norm(p):
    return p.replace(os.sep, "/")


def _is_exec(relpath):
    rel = _norm(relpath)
    name = os.path.basename(rel)
    ext = os.path.splitext(name)[1].lower()
    parts = rel.split("/")
    if "bin" in parts or "scripts" in parts or "sbin" in parts:
        return True
    if name in EXEC_NAMES:
        return True
    if ext in EXEC_EXTS:
        return True
    return False


def add_file(tar, filepath, arcname, mode=None):
    """向 tar 添加一个文件,自动决定 0644/0755。"""
    info = tar.gettarinfo(filepath, arcname=_norm(arcname))
    if mode is not None:
        info.mode = mode
    else:
        info.mode = 0o755 if _is_exec(arcname) else 0o644
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    with open(filepath, "rb") as fh:
        tar.addfile(info, fh)


def add_tree(tar, src_dir, prefix=""):
    """把 src_dir 下所有内容加入 tar,保留相对路径(可加 prefix)。"""
    for root, dirs, files in os.walk(src_dir):
        dirs.sort()
        files.sort()
        rel_root = os.path.relpath(root, src_dir)
        if rel_root == ".":
            rel_root = ""
        for d in dirs:
            arc = _norm(os.path.join(prefix, rel_root, d)) if rel_root else _norm(os.path.join(prefix, d))
            ti = tarfile.TarInfo(arc)
            ti.type = tarfile.DIRTYPE
            ti.mode = 0o755
            ti.uid = ti.gid = 0
            tar.addfile(ti)
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, src_dir)
            arc = _norm(os.path.join(prefix, rel))
            add_file(tar, full, arc)


def render_info(fields):
    """把字段字典渲染成 INFO 文本。"""
    out = []
    for k, v in fields.items():
        if v is None or v == "":
            continue
        v = str(v).replace("\\", "\\\\").replace('"', '\\"')
        out.append('{k}="{v}"'.format(k=k, v=v))
    return "\n".join(out) + "\n"


def render_start_stop_status(pkg, binary, start_cmd=None, stop_cmd=None):
    """生成默认 start-stop-status 脚本。"""
    b = '"$TARGET/bin/%s"' % binary
    start = start_cmd or ('%s >>"$LOG" 2>&1 & echo $! > "$PIDFILE"' % b)
    stop = stop_cmd or ('[ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null; rm -f "$PIDFILE"')
    lines = [
        "#!/bin/sh",
        'PKG="%s"' % pkg,
        'TARGET="/var/packages/$PKG/target"',
        'VAR="/var/packages/$PKG/var"',
        'PIDFILE="$VAR/$PKG.pid"',
        'LOG="$VAR/$PKG.log"',
        'mkdir -p "$VAR"',
        "",
        "start_daemon() {",
        "  %s" % start,
        "}",
        "",
        "stop_daemon() {",
        "  %s" % stop,
        "}",
        "",
        "status_daemon() {",
        '  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then exit 0; else exit 3; fi',
        "}",
        "",
        'case "$1" in',
        "  start)  start_daemon;  exit 0 ;;",
        "  stop)   stop_daemon;   exit 0 ;;",
        "  status) status_daemon ;;",
        "esac",
        "exit 0",
    ]
    return "\n".join(lines) + "\n"


def make_icon(path, size, color=(47, 128, 237)):
    """生成占位图标(优先 Pillow)。"""
    try:
        from PIL import Image, ImageDraw
        img = Image.new("RGB", (size, size), color)
        d = ImageDraw.Draw(img)
        margin = max(2, size // 8)
        d.rectangle(
            [margin, margin, size - margin - 1, size - margin - 1],
            outline=(255, 255, 255), width=max(1, size // 32),
        )
        img.save(path, "PNG")
        return True
    except Exception:
        return False


def build_spk(output_dir, *, name, version, arch, info_fields, target_dir,
              scripts_dir=None, icons_dir=None, binary=None,
              start_cmd=None, stop_cmd=None, extra_dir=None,
              run_as=None, run_user=None):
    """把 target_dir 打包为 <output_dir>/<name>[-arch]-<version>.spk,返回 spk 路径。"""
    os.makedirs(output_dir, exist_ok=True)
    arch_suffix = "" if arch in ("noarch", "all") else ("-" + arch)
    spk_name = "{n}{a}-{v}.spk".format(n=name, a=arch_suffix, v=version)
    spk_path = os.path.join(output_dir, spk_name)
    tmp_tgz = os.path.join(output_dir, "." + spk_name + ".package.tgz")
    stage = os.path.join(output_dir, "." + spk_name + ".stage")

    if os.path.isdir(stage):
        shutil.rmtree(stage)
    os.makedirs(stage)

    # 1) package.tgz = gzip tar(target_dir 的内容)
    with tarfile.open(tmp_tgz, "w:gz") as tar:
        add_tree(tar, target_dir)

    # 2) INFO
    info_fields = dict(info_fields)
    info_fields.setdefault("package", name)
    info_fields.setdefault("version", version)
    info_fields.setdefault("arch", arch)
    info_fields.setdefault("os_min_ver", "7.0-40000")
    with open(os.path.join(stage, "INFO"), "w", encoding="utf-8") as fh:
        fh.write(render_info(info_fields))

    shutil.copyfile(tmp_tgz, os.path.join(stage, "package.tgz"))

    # 3) scripts
    sdir = os.path.join(stage, "scripts")
    os.makedirs(sdir, exist_ok=True)
    if scripts_dir and os.path.isdir(scripts_dir):
        for f in os.listdir(scripts_dir):
            src = os.path.join(scripts_dir, f)
            if os.path.isfile(src):
                shutil.copyfile(src, os.path.join(sdir, f))
    for f in ("preinst", "postinst", "preuninst", "postuninst", "preupgrade", "postupgrade"):
        p = os.path.join(sdir, f)
        if not os.path.exists(p):
            with open(p, "w", encoding="utf-8") as fh:
                fh.write("#!/bin/sh\nexit 0\n")
    sss = os.path.join(sdir, "start-stop-status")
    if not os.path.exists(sss):
        with open(sss, "w", encoding="utf-8") as fh:
            fh.write(render_start_stop_status(name, binary or name, start_cmd, stop_cmd))

    # 4) icons
    if icons_dir and os.path.isdir(icons_dir):
        for f in os.listdir(icons_dir):
            if f.upper().startswith("PACKAGE_ICON") and f.upper().endswith(".PNG"):
                shutil.copyfile(os.path.join(icons_dir, f), os.path.join(stage, f))
    if not os.path.exists(os.path.join(stage, "PACKAGE_ICON.PNG")):
        make_icon(os.path.join(stage, "PACKAGE_ICON.PNG"), 64)
    if not os.path.exists(os.path.join(stage, "PACKAGE_ICON_256.PNG")):
        make_icon(os.path.join(stage, "PACKAGE_ICON_256.PNG"), 256)

    # 5) 额外的外层资源(conf / WIZARD_UIFILES / LICENSE)
    if extra_dir and os.path.isdir(extra_dir):
        for entry in ("conf", "WIZARD_UIFILES", "LICENSE"):
            src = os.path.join(extra_dir, entry)
            if os.path.isdir(src):
                shutil.copytree(src, os.path.join(stage, entry), dirs_exist_ok=True)
            elif os.path.isfile(src):
                shutil.copyfile(src, os.path.join(stage, entry))

    # 5.5) 运行权限(conf/privilege)——在 extra_dir 之后生成,确保用户选择优先
    if run_as in ("root", "package"):
        os.makedirs(os.path.join(stage, "conf"), exist_ok=True)
        priv = {"defaults": {"run-as": run_as}}
        if run_as == "package" and run_user:
            priv["username"] = run_user
        with open(os.path.join(stage, "conf", "privilege"), "w", encoding="utf-8") as fh:
            fh.write(json.dumps(priv, ensure_ascii=False, indent=2) + "\n")

    # 6) 外层 = 不压缩 tar,INFO 放最前
    with tarfile.open(spk_path, "w") as tar:
        add_file(tar, os.path.join(stage, "INFO"), "INFO", 0o644)
        for entry in sorted(os.listdir(stage)):
            if entry == "INFO":
                continue
            full = os.path.join(stage, entry)
            if os.path.isdir(full):
                add_tree(tar, full, entry)
            else:
                add_file(tar, full, entry)

    os.remove(tmp_tgz)
    shutil.rmtree(stage)
    return spk_path


def unpack_spk(spk_path, out_dir):
    """解包 .spk 为「可二次打包」的工程目录:
    外层文件(INFO/package.tgz/scripts/图标/conf 等)-> out_dir/ 根目录,
    内层 package.tgz -> out_dir/target/。
    返回 {"info": {key:value}, "outer": [..], "target": [..]}。"""
    import io
    os.makedirs(out_dir, exist_ok=True)
    target_dir = os.path.join(out_dir, "target")
    os.makedirs(target_dir, exist_ok=True)

    info = {}
    outer_files = []
    target_files = []

    def _safe_write(dest_base, arcname, data):
        base = os.path.abspath(dest_base)
        target = os.path.abspath(os.path.join(dest_base, arcname))
        if not (target == base or target.startswith(base + os.sep)):
            return False
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as fh:
            fh.write(data)
        return True

    def _extract(tar, dest_dir, collect):
        for m in tar.getmembers():
            if m.isdir() or m.issym() or m.islnk():
                continue
            f = tar.extractfile(m)
            if f is None:
                continue
            if _safe_write(dest_dir, m.name, f.read()):
                collect.append(m.name)

    with tarfile.open(spk_path, "r:*") as t:
        for m in t.getmembers():
            if m.isdir():
                continue
            f = t.extractfile(m)
            if f is None:
                continue
            data = f.read()
            if m.name == "INFO":
                _safe_write(out_dir, "INFO", data)
                for line in data.decode("utf-8", "replace").splitlines():
                    line = line.strip()
                    if "=" in line:
                        k, v = line.split("=", 1)
                        info[k.strip()] = v.strip().strip('"').strip()
            elif m.name == "package.tgz":
                _safe_write(out_dir, "package.tgz", data)
                with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as tgz:
                    _extract(tgz, target_dir, target_files)
            else:
                if m.issym() or m.islnk():
                    continue
                if _safe_write(out_dir, m.name, data):
                    outer_files.append(m.name)

    return {"info": info, "outer": sorted(outer_files), "target": sorted(target_files)}


_X86 = {"x86_64", "x86", "i686", "bromolow", "cedarview", "broadwell", "avoton",
        "braswell", "apollolake", "geminilake", "denverton", "v1000", "r1000",
        "epyc7002", "broadwellnk", "grantley", "purley", "kvmx64"}
_ARM64 = {"arm64", "aarch64", "rtd1619b", "rtd1296", "rtd1293", "armada8040"}
_ARM = {"armv7", "armv7l", "armada370", "armada375", "armada38x", "armadaxp",
        "alpine", "alpine4k", "monaco", "hi3535", "comcerto2k", "armada37xx"}


def map_arch(arch_str):
    """把 INFO 的 arch 字段(平台名/架构)粗略映射成 x86_64/arm64/armv7/noarch。"""
    tokens = [t.lower() for t in str(arch_str or "").split()]
    if not tokens or "noarch" in tokens or "all" in tokens:
        return ["noarch"]
    out = []
    for a in tokens:
        if a in _X86:
            out.append("x86_64")
        elif a in _ARM64:
            out.append("arm64")
        elif a in _ARM:
            out.append("armv7")
    return list(dict.fromkeys(out))
