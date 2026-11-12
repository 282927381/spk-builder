#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
builders.py — 构建提供者(交叉编译)与工具链检测。

支持:
  * go      : 本机 Go 交叉编译(GOOS=linux, 静态 CGO_ENABLED=0)
  * docker  : 在 Docker 容器里执行任意构建命令(适合 C/C++ 等,需要 Docker Desktop)
  * local   : 在本机执行任意命令(Windows 下走 cmd,Linux 下走 sh)
  * prebuilt: 不编译,直接把已有目录打进 .spk
"""
import os
import shutil
import subprocess
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
BUNDLED_TOOLS = os.path.join(BASE, "tools")

ARCH_GO = {"x86_64": "amd64", "i686": "386", "armv7": "arm", "arm64": "arm64"}


def _which(name):
    p = shutil.which(name)
    if p:
        return p
    if os.name == "nt":
        for ext in (".exe", ".cmd", ".bat"):
            p = shutil.which(name + ext)
            if p:
                return p
    return None


def go_path():
    local = os.path.join(BUNDLED_TOOLS, "go", "bin", "go.exe" if os.name == "nt" else "go")
    if os.path.exists(local):
        return local
    return _which("go")


def detect():
    """检测可用的工具链。"""
    return {
        "go": go_path(),
        "cargo": _which("cargo"),
        "rustc": _which("rustc"),
        "docker": _which("docker"),
        "wsl": _which("wsl"),
        "python": sys.executable,
    }


def run(cmd, cwd, env, log):
    log("$ " + " ".join(cmd))
    proc = subprocess.Popen(
        cmd, cwd=cwd, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
    )
    for line in proc.stdout:
        line = line.rstrip("\n")
        if line:
            log(line)
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError("命令执行失败,退出码 %d" % proc.returncode)


def build_go(cfg, arch, out_bin, log):
    go = cfg["_go"]
    goarch = ARCH_GO.get(arch, "amd64")
    env = os.environ.copy()
    env["GOOS"] = "linux"
    env["GOARCH"] = goarch
    if goarch == "arm":
        env["GOARM"] = str(cfg.get("go_arm", "7"))
    env["CGO_ENABLED"] = "1" if cfg.get("go_cgo_enabled") else "0"
    ldflags = cfg.get("go_ldflags") or "-s -w"
    mainpkg = cfg.get("main_pkg") or "."
    os.makedirs(os.path.dirname(out_bin), exist_ok=True)
    cmd = [go, "build", "-trimpath", "-ldflags", ldflags, "-o", out_bin, mainpkg]
    run(cmd, cfg.get("source_dir"), env, log)


def build_local(cfg, arch, out_bin, log):
    cmd_str = (cfg.get("local_cmd") or "").strip()
    if not cmd_str:
        raise RuntimeError("本地构建模式需要填写构建命令(local_cmd)")
    env = os.environ.copy()
    env["OUT_BIN"] = out_bin
    env["OUT_DIR"] = os.path.dirname(out_bin)
    env["ARCH"] = arch
    if os.name == "nt":
        run(["cmd", "/c", cmd_str], cfg.get("source_dir"), env, log)
    else:
        run(["sh", "-c", cmd_str], cfg.get("source_dir"), env, log)


def build_docker(cfg, arch, out_bin, log):
    docker = cfg["_docker"]
    image = cfg.get("docker_image") or "debian:bookworm-slim"
    cmd_str = (cfg.get("docker_cmd") or "").strip()
    if not cmd_str:
        raise RuntimeError("Docker 构建模式需要填写构建命令(docker_cmd)")
    src = os.path.abspath(cfg.get("source_dir"))
    outdir = os.path.dirname(out_bin)
    os.makedirs(outdir, exist_ok=True)
    binname = os.path.basename(out_bin)
    inner = "set -e; mkdir -p /out/bin; " + cmd_str
    cmd = [
        docker, "run", "--rm",
        "-v", src + ":/src",
        "-v", outdir + ":/out",
        "-e", "ARCH=" + arch,
        "-e", "OUT_BIN=/out/bin/" + binname,
        "-e", "OUT_DIR=/out",
        "-w", "/src",
        image, "sh", "-c", inner,
    ]
    run(cmd, None, os.environ.copy(), log)


SPKSRC_ARCH = {"x86_64": "x64", "i686": "x64", "arm64": "aarch64", "armv7": "armv7"}


def win_to_wsl_path(path):
    """把 Windows 路径转成 WSL 挂载路径:C:\\dir\\sub -> /mnt/c/dir/sub"""
    p = os.path.abspath(path).replace("\\", "/")
    if len(p) >= 2 and p[1] == ":":
        return "/mnt/%s%s" % (p[0].lower(), p[2:])
    return p


def build_spksrc(cfg, arch, out_dir, log):
    """通过 WSL2 运行 SynoCommunity/spksrc 交叉编译,并把 .spk 拷回 Windows 目录。"""
    wsl = _which("wsl")
    if not wsl:
        raise RuntimeError("未检测到 WSL。spksrc 需要在 WSL2/Linux 环境里运行。")
    distro = cfg.get("wsl_distro") or "Ubuntu"
    sarch = SPKSRC_ARCH.get(arch)
    if not sarch:
        raise RuntimeError("spksrc 模式不支持架构 '%s'(请选 x86_64 / armv7 / arm64)" % arch)
    spksrc_dir = (cfg.get("spksrc_dir") or "~/spksrc").strip()
    pkg = (cfg.get("spksrc_pkg") or cfg.get("name") or "").strip()
    tc = (cfg.get("tcversion") or "7.2").strip()
    if not pkg:
        raise RuntimeError("spksrc 模式需要填写包名(spk/ 下的目录名)")

    # 预检:发行版是否可用
    log("检查 WSL 发行版 '%s' ..." % distro)
    chk = subprocess.run([wsl, "-d", distro, "-e", "true"], capture_output=True, timeout=60)
    if chk.returncode != 0:
        raise RuntimeError(
            "WSL 发行版 '%s' 不可用。请先以管理员身份运行: wsl --install -d %s" % (distro, distro))

    os.makedirs(out_dir, exist_ok=True)
    out_wsl = win_to_wsl_path(out_dir)
    script = (
        'set -e; '
        'SRC="$1"; PKG="$2"; ARCH="$3"; TC="$4"; OUT="$5"; '
        'if [ ! -d "$SRC/spk/$PKG" ]; then '
        '  echo "[错误] 找不到 spk/$PKG,请确认 spksrc 目录与包名,或先: git clone https://github.com/SynoCommunity/spksrc"; '
        '  exit 2; fi; '
        'cd "$SRC"; '
        '[ -f local.mk ] || make setup; '
        'make -C "spk/$PKG" ARCH="$ARCH" TCVERSION="$TC"; '
        'mkdir -p "$OUT"; '
        'cp -f "packages/${PKG}"_*.spk "$OUT"/ 2>/dev/null || echo "[提示] 未在 packages/ 找到匹配的 .spk"; '
    )
    cmd = [wsl, "-d", distro, "-e", "bash", "-lc", script, "_", spksrc_dir, pkg, sarch, tc, out_wsl]
    run(cmd, None, os.environ.copy(), log)
