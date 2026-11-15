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
  const btn = $("#btnImport");
  status.textContent = "解包中…";
  $("#importResult").classList.add("hidden");
  $("#unpackLogbox").classList.remove("hidden");
  $("#unpackLog").textContent = "";
  btn.disabled = true;
  try {
    let jid;
    if (fileInput.files && fileInput.files.length > 0) {
      const file = fileInput.files[0];
      const buf = await file.arrayBuffer();
      const r = await fetch("/api/import-job?filename=" + encodeURIComponent(file.name), {
        method: "POST",
        body: buf,
        headers: { "Content-Type": "application/octet-stream" },
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      jid = j.job_id;
    } else if (path) {
      const r = await fetch("/api/import-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      jid = j.job_id;
    } else {
      status.textContent = "请选择文件或填写路径";
      return;
    }
    const result = await pollJobLog(jid, $("#unpackLog"));
    renderImport(result);
    switchTab("build");
    status.textContent = "已解包并回填套件信息,可修改后直接二次打包";
    fileInput.value = "";
    $("#importPath").value = "";
  } catch (e) {
    $("#unpackLog").textContent += "\n❌ 解包失败: " + e.message + "\n";
    status.textContent = "解包失败: " + e.message;
  } finally {
    btn.disabled = false;
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

function pollJobLog(jid, logEl) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(async () => {
      try {
        const r = await fetch("/api/jobs/" + jid);
        const j = await r.json();
        const existing = logEl.textContent.split("\n");
        const seen = new Set(existing);
        (j.log || []).forEach((line) => {
          if (!seen.has(line)) logEl.textContent += line + "\n";
        });
        logEl.scrollTop = logEl.scrollHeight;
        if (j.status === "done") {
          clearInterval(timer);
          resolve(j.result || {});
        } else if (j.status === "error") {
          clearInterval(timer);
          reject(new Error(j.error || "未知错误"));
        }
      } catch (e) {
        // 网络抖动,忽略继续轮询
      }
    }, 300);
  });
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

/* ==================== 批量功能 ==================== */

const batchItems = []; // 每个元素:一次解包结果 {dir, info, name, version, arch:[], run_as, run_user}
const BATCH_ARCHS = ["x86_64", "armv7", "arm64", "noarch"];

// 镜像站(sspks-imnks)支持的架构家族：x86_64 与 armv8(即 arm64)，noarch 通用。
// armv7 不在镜像站 DSM7 机型家族映射(conf/synology_models.yaml)中，故默认不勾选(仍可手动勾选)。
const MIRROR_SUPPORTED_ARCHS = new Set(["x86_64", "arm64", "noarch"]);

function appendBatchLog(line) {
  $("#batchLogbox").classList.remove("hidden");
  const el = $("#batchLog");
  el.textContent += line + "\n";
  el.scrollTop = el.scrollHeight;
}

function batchCardHTML(it, i) {
  const info = it.info || {};
  const archs = it.arch && it.arch.length ? it.arch : ["noarch"];
  const runAs = it.run_as === "package" ? "package" : "root";
  const f = (k) => (info[k] != null ? info[k] : "");
  const archChips = BATCH_ARCHS.map((a) => {
    const on = archs.includes(a);
    return `<label><input type="checkbox" class="arch-opt" value="${a}" ${on ? "checked" : ""} /> ${a}</label>`;
  }).join("");
  return `
  <div class="batch-card" data-index="${i}">
    <div class="card-head">
      <input type="checkbox" class="card-select" checked />
      <span class="card-title">${esc(it.name || "未命名")}${it.version ? "<em> v" + esc(it.version) + "</em>" : ""}</span>
      <button type="button" class="card-remove" data-index="${i}">删除</button>
    </div>
    <div class="card-body grid">
      <label>套件标识<span class="req">*</span>
        <input data-field="name" value="${esc(f("package"))}" />
      </label>
      <label>版本<span class="req">*</span>
        <input data-field="version" value="${esc(f("version"))}" />
      </label>
      <label>显示名称
        <input data-field="displayname" value="${esc(f("displayname"))}" />
      </label>
      <label>中文显示名
        <input data-field="displayname_chs" value="${esc(f("displayname_chs"))}" />
      </label>
      <label>描述
        <input data-field="description" value="${esc(f("description"))}" />
      </label>
      <label>中文描述
        <input data-field="description_chs" value="${esc(f("description_chs"))}" />
      </label>
      <label>维护者
        <input data-field="maintainer" value="${esc(f("maintainer"))}" />
      </label>
      <label>维护者网址
        <input data-field="maintainer_url" value="${esc(f("maintainer_url"))}" />
      </label>
      <label>发行者
        <input data-field="distributor" value="${esc(f("distributor"))}" />
      </label>
      <label>发行者网址
        <input data-field="distributor_url" value="${esc(f("distributor_url"))}" />
      </label>
      <label>支持网址
        <input data-field="support_url" value="${esc(f("support_url"))}" />
      </label>
      <label>运行程序名(binary_name)
        <input data-field="binary_name" value="${esc(f("binary_name"))}" />
      </label>
      <label>最低 DSM 版本
        <input data-field="os_min_ver" value="${esc(f("os_min_ver"))}" />
      </label>
      <label>运行用户名(非 root 时)
        <input data-field="run_user" value="${esc(it.run_user || "")}" />
      </label>
      <label class="full">启动命令(start)
        <textarea data-field="start_cmd" rows="2" placeholder="留空则默认运行 target/bin/&lt;binary_name&gt; 并记录 PID">${esc(f("start_cmd"))}</textarea>
      </label>
      <label class="full">停止命令(stop)
        <textarea data-field="stop_cmd" rows="2" placeholder="留空则默认按 PID 文件 kill">${esc(f("stop_cmd"))}</textarea>
      </label>
      <label class="full">源目录(解包目录,可改)
        <input data-field="source_dir" value="${esc(it.dir || "")}" />
      </label>
      <label class="full">目标架构
        <div class="chips">${archChips}</div>
      </label>
      <label class="full">运行身份
        <div class="modes" style="flex-direction:row; gap:20px">
          <label><input type="radio" class="runas-opt" name="runas-${i}" value="root" ${runAs === "root" ? "checked" : ""} /> root(最高权限)</label>
          <label><input type="radio" class="runas-opt" name="runas-${i}" value="package" ${runAs === "package" ? "checked" : ""} /> 非 root(DSM 7 推荐)</label>
        </div>
      </label>
    </div>
  </div>`;
}

function renderBatchList() {
  const list = $("#batchList");
  $("#batchTasks").classList.toggle("hidden", batchItems.length === 0);
  if (batchItems.length === 0) {
    list.innerHTML = "";
    return;
  }
  list.innerHTML = batchItems.map((it, i) => batchCardHTML(it, i)).join("");
  $$(".card-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      batchItems.splice(parseInt(btn.dataset.index, 10), 1);
      renderBatchList();
    });
  });
}

async function importOne(fileOrPath) {
  if (typeof fileOrPath === "string") {
    const r = await fetch("/api/import-job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fileOrPath }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return pollJobLog(j.job_id, $("#batchLog"));
  }
  const buf = await fileOrPath.arrayBuffer();
  const r = await fetch("/api/import-job?filename=" + encodeURIComponent(fileOrPath.name), {
    method: "POST",
    body: buf,
    headers: { "Content-Type": "application/octet-stream" },
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return pollJobLog(j.job_id, $("#batchLog"));
}

async function doBatchImport() {
  const fileInput = $("#batchFile");
  const pathsText = $("#batchPaths").value.trim();
  const status = $("#batchImportStatus");
  const files = fileInput.files ? Array.from(fileInput.files) : [];
  const paths = pathsText ? pathsText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];

  if (files.length === 0 && paths.length === 0) {
    status.textContent = "请选择文件或填写路径";
    return;
  }
  status.textContent = "正在批量解包…";
  $("#batchLog").textContent = "";
  $("#batchLogbox").classList.remove("hidden");
  let ok = 0, fail = 0;
  const tasks = files.concat(paths);
  for (const t of tasks) {
    const label = typeof t === "string" ? t : t.name;
    appendBatchLog(`【${ok + fail + 1}/${tasks.length}】${label}`);
    try {
      const res = await importOne(t);
      batchItems.push(res);
      ok++;
    } catch (e) {
      fail++;
      appendBatchLog("❌ 解包失败 [" + label + "]: " + e.message);
    }
  }
  status.textContent = `批量解包完成: 成功 ${ok} / 失败 ${fail}`;
  fileInput.value = "";
  $("#batchPaths").value = "";
  renderBatchList();
}

function collectCardConfig(card) {
  const g = (field) => (card.querySelector(`[data-field="${field}"]`) || {}).value || "";
  const archs = Array.from(card.querySelectorAll(".arch-opt:checked")).map((e) => e.value);
  const runAs = (card.querySelector(".runas-opt:checked") || {}).value || "root";
  return {
    name: g("name").trim(),
    version: g("version").trim(),
    displayname: g("displayname").trim(),
    displayname_chs: g("displayname_chs").trim(),
    description: g("description").trim(),
    description_chs: g("description_chs").trim(),
    maintainer: g("maintainer").trim(),
    maintainer_url: g("maintainer_url").trim(),
    distributor: g("distributor").trim(),
    distributor_url: g("distributor_url").trim(),
    support_url: g("support_url").trim(),
    os_min_ver: g("os_min_ver").trim(),
    binary_name: g("binary_name").trim(),
    run_as: runAs,
    run_user: g("run_user").trim(),
    start_cmd: g("start_cmd").trim(),
    stop_cmd: g("stop_cmd").trim(),
    archs: archs,
    mode: "prebuilt",
    source_dir: g("source_dir").trim(),
  };
}

async function doBatchBuild() {
  const cards = $$(".batch-card");
  const selected = cards.filter((c) => c.querySelector(".card-select").checked);
  const status = $("#batchStatus");
  if (selected.length === 0) {
    status.textContent = "请至少勾选一个包";
    return;
  }
  const items = [];
  for (const card of selected) {
    const cfg = collectCardConfig(card);
    if (!cfg.name || !cfg.version) {
      status.textContent = "存在未填写「套件标识/版本」的包，请检查";
      return;
    }
    if (cfg.archs.length === 0) {
      status.textContent = "包「" + cfg.name + "」未选择目标架构";
      return;
    }
    if (!cfg.source_dir) {
      status.textContent = "包「" + cfg.name + "」源目录为空";
      return;
    }
    items.push(cfg);
  }

  const btn = $("#btnBatchBuild");
  btn.disabled = true;
  status.textContent = "正在提交…";
  $("#batchResult").classList.add("hidden");
  $("#batchDownloads").innerHTML = "";
  $("#batchLog").textContent = "";
  $("#batchLogbox").classList.remove("hidden");
  try {
    const r = await fetch("/api/batch-build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    await pollBatchJob(j.job_id);
    status.textContent = "";
  } catch (e) {
    appendBatchLog("提交失败: " + e.message);
    status.textContent = "失败";
  } finally {
    btn.disabled = false;
  }
}

function pollBatchJob(jid) {
  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      try {
        const r = await fetch("/api/jobs/" + jid);
        const j = await r.json();
        const el = $("#batchLog");
        const existing = el.textContent.split("\n");
        const seen = new Set(existing);
        (j.log || []).forEach((line) => {
          if (!seen.has(line)) el.textContent += line + "\n";
        });
        el.scrollTop = el.scrollHeight;
        if (j.status === "done") {
          clearInterval(timer);
          renderBatchResult(j.result);
          resolve();
        } else if (j.status === "error") {
          clearInterval(timer);
          appendBatchLog("❌ 批量构建失败: " + (j.error || "未知错误"));
          resolve();
        }
      } catch (e) {
        // 网络抖动,忽略继续轮询
      }
    }, 800);
  });
}

function renderBatchResult(result) {
  const box = $("#batchResult");
  const dl = $("#batchDownloads");
  box.classList.remove("hidden");
  if (!result || !result.items || result.items.length === 0) {
    dl.innerHTML = `<span class="status">无结果</span>`;
    return;
  }
  const parts = result.items.map((it) => {
    if (!it.ok) {
      return `<div class="batch-res-item fail"><b>❌ ${esc(it.label)}</b><span class="status">${esc(it.error || "构建失败")}</span></div>`;
    }
    const links = (it.spks || [])
      .map((s) => {
        const supported = MIRROR_SUPPORTED_ARCHS.has(s.arch);
        const tip = supported ? "镜像站支持的机型，默认勾选" : "镜像站未收录该架构(armv7)，可手动勾选";
        return `<label class="dl-check" title="${tip}">
          <input type="checkbox" class="dl-opt" data-name="${esc(it.name || "")}" data-path="${s.url}" data-filename="${esc(s.filename)}" ${supported ? "checked" : ""} />
          <span class="dl-text">${esc(s.filename)} <small>(${s.arch})</small></span>
        </label>`;
      })
      .join("");
    return `<div class="batch-res-item ok"><b>✅ ${esc(it.label)}</b><div class="res-links">${links}</div></div>`;
  });
  dl.innerHTML = `
    <div class="batch-summary">
      <span>批量构建完成: 成功 ${result.ok} / 失败 ${result.fail} / 共 ${result.total}</span>
      <span class="batch-dl-bar">
        <label class="check"><input type="checkbox" id="dlSelectAll" checked /> 全选</label>
        <button type="button" id="btnBatchDownload">⬇️ 批量下载</button>
      </span>
    </div>` + parts.join("");

  $("#dlSelectAll").addEventListener("change", (e) => {
    $$(".dl-opt").forEach((c) => { c.checked = e.target.checked; });
    updateDlCount();
  });
  $("#btnBatchDownload").addEventListener("click", batchDownload);
  $$(".dl-opt").forEach((c) => c.addEventListener("change", updateDlCount));
  updateDlCount();
}

function updateDlCount() {
  const opts = $$(".dl-opt");
  const checked = opts.filter((c) => c.checked).length;
  const btn = $("#btnBatchDownload");
  if (btn) btn.textContent = `⬇️ 批量下载（已勾选 ${checked} 个）`;
  const sel = $("#dlSelectAll");
  if (sel && opts.length > 0) {
    sel.checked = checked === opts.length;
    sel.indeterminate = checked > 0 && checked < opts.length;
  }
}

async function batchDownload() {
  const opts = $$(".dl-opt:checked");
  if (opts.length === 0) return;
  const btn = $("#btnBatchDownload");
  const files = opts.map((opt) => ({
    name: opt.dataset.name || "",
    path: opt.dataset.path || "",
  }));
  if (btn) { btn.disabled = true; btn.textContent = "正在打包…"; }
  try {
    const r = await fetch("/api/batch-download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || ("打包失败(" + r.status + ")"));
    }
    const blob = await r.blob();
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = "spk-packages-dsm7.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert("批量下载失败: " + e.message);
  } finally {
    if (btn) { btn.disabled = false; updateDlCount(); }
  }
}

function clearBatch() {
  batchItems.length = 0;
  renderBatchList();
  $("#batchResult").classList.add("hidden");
  $("#batchDownloads").innerHTML = "";
  $("#batchLogbox").classList.add("hidden");
  $("#batchLog").textContent = "";
  $("#batchStatus").textContent = "";
  $("#batchImportStatus").textContent = "";
}

/* ==================== 批量修改单一信息 ==================== */

function switchBatchEditField() {
  const field = $("#batchEditField").value;
  const isArch = field === "archs";
  const isRunAs = field === "run_as";
  $("#batchEditValue").classList.toggle("hidden", isArch || isRunAs);
  $("#batchEditArchs").classList.toggle("hidden", !isArch);
  $("#batchEditRunAs").classList.toggle("hidden", !isRunAs);
  $("#batchEditStatus").textContent = "";
}

function applyBatchEdit() {
  const field = $("#batchEditField").value;
  const cards = $$(".batch-card");
  const status = $("#batchEditStatus");
  if (cards.length === 0) {
    status.textContent = "暂无批量任务，请先解包";
    return;
  }
  if (field === "archs") {
    const archs = Array.from(document.querySelectorAll(".arch-edit-opt:checked")).map((e) => e.value);
    if (archs.length === 0) {
      status.textContent = "请至少勾选一个架构";
      return;
    }
    cards.forEach((card) => {
      card.querySelectorAll(".arch-opt").forEach((c) => { c.checked = archs.includes(c.value); });
    });
    status.textContent = `已把架构应用到 ${cards.length} 个包`;
    return;
  }
  if (field === "run_as") {
    const runAs = (document.querySelector('input[name="batch-edit-runas"]:checked') || {}).value || "root";
    cards.forEach((card) => {
      card.querySelectorAll(".runas-opt").forEach((r) => { r.checked = r.value === runAs; });
    });
    status.textContent = `已把运行身份应用到 ${cards.length} 个包`;
    return;
  }
  const value = $("#batchEditValue").value;
  let applied = 0;
  cards.forEach((card) => {
    const el = card.querySelector(`[data-field="${field}"]`);
    if (el) {
      el.value = value;
      applied++;
    }
  });
  status.textContent = `已把「${$("#batchEditField").selectedOptions[0].text}」应用到 ${applied} 个包`;
}

/* ==================== 更新日志 ==================== */

function renderChangelog(content) {
  const box = $("#changelogContent");
  const lines = String(content || "").replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "更新日志") continue;
    if (/^V\d+\.\d+\.\d+/.test(line)) {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<h3 class="cl-version">${esc(line)}</h3>`;
      continue;
    }
    if (line.startsWith("【") && line.endsWith("】")) {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<h4 class="cl-cat">${esc(line)}</h4>`;
      continue;
    }
    if (line.startsWith("-")) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${esc(line.replace(/^-\s*/, ""))}</li>`;
      continue;
    }
    if (inList) { html += "</ul>"; inList = false; }
    html += `<p>${esc(line)}</p>`;
  }
  if (inList) html += "</ul>";
  box.innerHTML = html || "<p class='hint'>暂无更新日志</p>";
}

async function loadChangelog() {
  try {
    const r = await fetch("/api/changelog");
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    renderChangelog(j.content || "");
  } catch (e) {
    $("#changelogContent").innerHTML = `<p class="status">加载失败: ${esc(e.message)}</p>`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadStatus();
  loadChangelog();
  $$('input[name="mode"]').forEach((r) => r.addEventListener("change", switchMode));
  $$(".navtab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  $("#form").addEventListener("submit", doBuild);
  $("#btnClearLog").addEventListener("click", () => { $("#log").textContent = ""; });
  $("#btnImport").addEventListener("click", doImport);
  $("#btnClearUnpackLog").addEventListener("click", () => { $("#unpackLog").textContent = ""; });
  $("#btnBatchImport").addEventListener("click", doBatchImport);
  $("#btnBatchBuild").addEventListener("click", doBatchBuild);
  $("#btnBatchClear").addEventListener("click", clearBatch);
  $("#btnBatchClearLog").addEventListener("click", () => { $("#batchLog").textContent = ""; });
  $("#batchSelectAll").addEventListener("change", (e) => {
    $$(".card-select").forEach((c) => { c.checked = e.target.checked; });
  });
  $("#batchEditField").addEventListener("change", switchBatchEditField);
  $("#btnBatchEdit").addEventListener("click", applyBatchEdit);
  switchBatchEditField();
  switchMode();
});
