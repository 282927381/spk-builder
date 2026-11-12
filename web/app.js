"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const modePanel = {
  prebuilt: "panel-prebuilt",
  go: "panel-go",
  docker: "panel-docker",
  local: "panel-local",
  spksrc: "panel-spksrc",
};

function val(name) {
  return ($(`[name="${name}"]`) || {}).value || "";
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function checkedArchs() {
  return $$('input[name="arch"]:checked').map((e) => e.value);
}

function currentMode() {
  const r = document.querySelector('input[name="mode"]:checked');
  return r ? r.value : "prebuilt";
}

function switchMode() {
  const m = currentMode();
  Object.entries(modePanel).forEach(([k, id]) => {
    document.getElementById(id).classList.toggle("hidden", k !== m);
  });
}

function sourceDirForMode(m) {
  if (m === "go") return val("go_source_dir");
  if (m === "docker") return val("docker_source_dir");
  if (m === "local") return val("local_source_dir");
  return val("prebuilt_source_dir");
}

function buildPayload() {
  const m = currentMode();
  const cfg = {
    name: val("name"),
    version: val("version"),
    displayname: val("displayname"),
    displayname_chs: val("displayname_chs"),
    description: val("description"),
    description_chs: val("description_chs"),
    maintainer: val("maintainer"),
    maintainer_url: val("maintainer_url"),
    distributor: val("distributor"),
    distributor_url: val("distributor_url"),
    support_url: val("support_url"),
    os_min_ver: val("os_min_ver"),
    binary_name: val("binary_name"),
    run_as: (document.querySelector('input[name="run_as"]:checked') || {}).value || "root",
    run_user: val("run_user"),
    start_cmd: val("start_cmd"),
    stop_cmd: val("stop_cmd"),
    archs: checkedArchs(),
    mode: m,
    source_dir: sourceDirForMode(m),
  };
  if (m === "go") {
    cfg.main_pkg = val("main_pkg");
    cfg.go_ldflags = val("go_ldflags");
    cfg.go_cgo_enabled = document.querySelector('[name="go_cgo_enabled"]').checked;
  } else if (m === "docker") {
    cfg.docker_image = val("docker_image");
    cfg.docker_cmd = val("docker_cmd");
  } else if (m === "local") {
    cfg.local_cmd = val("local_cmd");
  } else if (m === "spksrc") {
    cfg.wsl_distro = val("wsl_distro");
    cfg.spksrc_dir = val("spksrc_dir");
    cfg.spksrc_pkg = val("spksrc_pkg");
    cfg.tcversion = val("tcversion");
  }
  return cfg;
}

function appendLog(line) {
  const log = $("#log");
  log.textContent += line + "\n";
  log.scrollTop = log.scrollHeight;
}

async function loadStatus() {
  try {
    const r = await fetch("/api/status");
    const s = await r.json();
    const t = s.tools || {};
    $("#outputDir").textContent = s.output_dir || "";
    renderBadges(t);
  } catch (e) {
    $("#tools").innerHTML = `<span class="badge bad">无法连接后端</span>`;
  }
}

function renderBadges(t) {
  const items = [
    ["Go", t.go, "交叉编译 Go"],
    ["Docker", t.docker, "编译 C/C++ 等"],
    ["Rust(cargo)", t.cargo, "交叉编译 Rust"],
    ["WSL", t.wsl, "Linux 工具链兜底"],
  ];
  $("#tools").innerHTML = items
    .map(([name, path, tip]) => {
      const ok = !!path;
      return `<span class="badge ${ok ? "ok" : "bad"}" title="${tip}">${name}: ${ok ? "已检测到" : "未安装"}</span>`;
    })
    .join("");
}

async function doBuild(ev) {
  ev.preventDefault();
  const btn = $("#btnBuild");
  const status = $("#status");
  btn.disabled = true;
  status.textContent = "正在提交…";
  $("#result").classList.add("hidden");
  $("#log").textContent = "";
  $("#downloads").innerHTML = "";

  const payload = buildPayload();
  if (payload.archs.length === 0) {
    status.textContent = "请至少选择一个目标架构";
    btn.disabled = false;
    return;
  }
  if (!payload.name || !payload.version) {
    status.textContent = "套件标识与版本为必填";
    btn.disabled = false;
    return;
  }

  try {
    const r = await fetch("/api/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    await pollJob(j.job_id);
    status.textContent = "";
  } catch (e) {
    appendLog("提交失败: " + e.message);
    status.textContent = "失败";
  } finally {
    btn.disabled = false;
  }
}

function pollJob(jid) {
  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      try {
        const r = await fetch("/api/jobs/" + jid);
        const j = await r.json();
        // 增量追加日志
        const el = $("#log");
        const existing = el.textContent.split("\n");
        const seen = new Set(existing);
        (j.log || []).forEach((line) => {
          if (!seen.has(line)) el.textContent += line + "\n";
        });
        el.scrollTop = el.scrollHeight;

        if (j.status === "done") {
          clearInterval(timer);
          renderResult(j.result);
          resolve();
        } else if (j.status === "error") {
          clearInterval(timer);
          appendLog("❌ 构建失败: " + (j.error || "未知错误"));
          resolve();
        }
      } catch (e) {
        // 网络抖动,忽略继续轮询
      }
    }, 800);
  });
}

function renderResult(result) {
  const box = $("#result");
  const dl = $("#downloads");
  box.classList.remove("hidden");
  if (!result || !result.spks || result.spks.length === 0) {
    dl.innerHTML = `<span class="status">无产物</span>`;
    return;
  }
  dl.innerHTML = result.spks
    .map(
      (s) =>
        `<a class="dl" href="${s.url}" download>⬇️ ${s.filename}<small>(${s.arch})</small></a>`
    )
    .join("");
}

async function doImport() {
  const fileInput = $("#importFile");
  const path = $("#importPath").value.trim();
  const status = $("#importStatus");
  status.textContent = "解包中…";
  $("#importResult").classList.add("hidden");
  try {
    let result;
    if (fileInput.files && fileInput.files.length > 0) {
      const file = fileInput.files[0];
      const buf = await file.arrayBuffer();
      const r = await fetch("/api/import?filename=" + encodeURIComponent(file.name), {
        method: "POST",
        body: buf,
        headers: { "Content-Type": "application/octet-stream" },
      });
      result = await r.json();
    } else if (path) {
      const r = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      result = await r.json();
    } else {
      status.textContent = "请选择文件或填写路径";
      return;
    }
    if (result.error) throw new Error(result.error);
    renderImport(result);
    switchTab("build");
    status.textContent = "已解包并回填套件信息,可修改后直接二次打包";
  } catch (e) {
    status.textContent = "解包失败: " + e.message;
  }
}

function renderImport(r) {
  $("#importResult").classList.remove("hidden");
  $("#importTitle").textContent = r.name
    ? `${r.name}  v${r.version || ""}`
    : "解包结果";
  const info = r.info || {};
  $("#importInfo").innerHTML = Object.entries(info)
    .map(([k, v]) => `<div class="kv"><b>${esc(k)}</b><span>${esc(v)}</span></div>`)
    .join("") || "<p class='hint'>(无 INFO)</p>";
  $("#importTree").textContent = (r.target || []).join("\n") || "(空)";
  $("#importDir").textContent = r.dir || "";
  fillFromImport(r);
}

const INFO_TO_FIELD = {
  package: "name",
  version: "version",
  displayname: "displayname",
  displayname_chs: "displayname_chs",
  description: "description",
  description_chs: "description_chs",
  maintainer: "maintainer",
  maintainer_url: "maintainer_url",
  distributor: "distributor",
  distributor_url: "distributor_url",
  support_url: "support_url",
  os_min_ver: "os_min_ver",
};

function fillFromImport(r) {
  const info = r.info || {};
  Object.entries(INFO_TO_FIELD).forEach(([k, field]) => {
    if (info[k] !== undefined && info[k] !== "") {
      const el = $(`[name="${field}"]`);
      if (el) el.value = info[k];
    }
  });
  // 架构回填(根据原始 arch 映射)
  const archs = r.arch || [];
  if (archs.length > 0) {
    $$('input[name="arch"]').forEach((c) => {
      c.checked = archs.includes(c.value);
    });
  }
  // 运行身份回填
  if (r.run_as === "root" || r.run_as === "package") {
    const el = document.querySelector(`input[name="run_as"][value="${r.run_as}"]`);
    if (el) el.checked = true;
  }
  if (r.run_user) {
    const u = $('[name="run_user"]');
    if (u) u.value = r.run_user;
  }
  // 切到预编译模式,并把源目录指向解包目录
  const prebuilt = document.querySelector('input[name="mode"][value="prebuilt"]');
  if (prebuilt) prebuilt.checked = true;
  const srcEl = $('[name="prebuilt_source_dir"]');
  if (srcEl && r.dir) srcEl.value = r.dir;
  switchMode();
}

function switchTab(tab) {
  $$(".navtab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".page").forEach((p) => p.classList.toggle("hidden", p.id !== "page-" + tab));
}

document.addEventListener("DOMContentLoaded", () => {
  loadStatus();
  $$('input[name="mode"]').forEach((r) => r.addEventListener("change", switchMode));
  $$(".navtab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  $("#form").addEventListener("submit", doBuild);
  $("#btnClearLog").addEventListener("click", () => { $("#log").textContent = ""; });
  $("#btnImport").addEventListener("click", doImport);
  switchMode();
});
