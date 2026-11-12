# SPK 构建台

一个**可视化 Web 操作台**,用来打包 / 构建群晖(Synology)套件安装包 `.spk`。
支持多种语言、多种架构,点几下就能出包,并可直接配合 [jdel/sspks](https://github.com/jdel/sspks) 套件服务器分发。

## 能做什么

| 能力 | 说明 |
| --- | --- |
| 打包 .spk | 生成完整的 `INFO` + `package.tgz` + `scripts/` + 图标,标准结构 |
| 多架构 | 一次勾选 `x86_64 / armv7 / arm64 / noarch`,每种架构出一个 .spk |
| 多语言构建 | Go(本机交叉编译)、Docker(C/C++ 等)、本地命令(任意语言)、预编译打包 |
| 可视化 | Web 表单填参数 + 实时构建日志 + 产物下载 |
| 零依赖可用 | 打包功能只用内置 Python 标准库,无需安装任何东西 |

## 一键启动

双击 `run.bat`,会自动打开浏览器 `http://127.0.0.1:8800`。

手动启动(任意有 Python 3 的环境):

```bash
python server.py
```

## 使用步骤

1. 打开 `http://127.0.0.1:8800`。
2. 顶部导航分三个页签:
   - **🚀 构建**:填写套件信息、架构、构建方式,出包;
   - **📥 解包**:导入现成 .spk 拆开分析,并自动回填到构建表单以便二次打包;
   - **📖 使用说明**:内置使用说明与常见问题。
3. 在「构建」页填写**套件信息**(名称、版本、描述、维护者等)。
4. 勾选**目标架构**(多选)。
5. 选择**构建方式**并填写相应参数(见下)。
6. 点 **🚀 开始打包 / 构建**,实时显示日志,完成后点击下载 .spk。

产物统一保存在 `output/<名称>-<版本>/` 目录下。

## 五种构建方式

### ① 预编译 / 纯脚本(prebuilt,默认,无需任何工具链)

把要安装的文件放进一个目录,目录结构直接对应安装后的 `target/`:

```
mypkg/
├── bin/
│   └── myapp          # 可执行文件(会被打包成 0755)
├── ui/                # 可选:DSM UI 文件
├── conf/              # 可选:配置文件
├── scripts/           # 可选:自定义生命周期脚本(缺失会自动生成)
├── PACKAGE_ICON.PNG       # 可选:图标,缺失自动生成占位图
└── PACKAGE_ICON_256.PNG
```

- **单架构**:直接把目录填进“源目录”。
- **多架构**:在源目录下按架构建子目录放各自二进制:
  ```
  mypkg/
  ├── x86_64/bin/myapp
  ├── armv7/bin/myapp
  └── arm64/bin/myapp
  ```

### ② Go(本机交叉编译)

需要本机安装 [Go](https://go.dev/dl/)(选 Windows 版安装,或解压便携版并加入 PATH)。
会以 `CGO_ENABLED=0` 生成**静态二进制**,对群晖最友好。

- 源码目录 = 你的 Go module 根目录
- 主包路径 = 如 `./cmd/server` 或 `.`
- 每个架构自动用 `GOOS=linux GOARCH=...` 编译

### ③ Docker(C/C++ 等任意编译)

需要 [Docker Desktop](https://www.docker.com/products/docker-desktop/)(启用 Linux 容器)。
源码挂载到容器内 `/src`,产物目录挂载到 `/out`;你的命令要把最终可执行文件写到 **`$OUT_BIN`**(即 `/out/bin/<binary_name>`)。

示例(编译一个静态 C 程序):

- Docker 镜像:`debian:bookworm-slim`
- 构建命令:`apt-get update && apt-get install -y gcc && gcc -static -o $OUT_BIN main.c`

> 群晖原生工具链可用官方镜像 `synocommunity/spksrc`(较重量级,适合真正需要群晖 libc 的场景)。

### ④ 本地命令(任意语言)

在本机执行一条命令,把最终可执行文件写到 `%OUT_BIN%`(Windows)/ `$OUT_BIN`(Linux),
可用环境变量 `ARCH` 区分架构。适合已有编译脚本的场景。

### ⑤ spksrc(SynoCommunity 交叉编译)

用官方 [spksrc](https://github.com/SynoCommunity/spksrc) 框架给群晖编译原生程序(C/C++、Rust、Go 等),
自带各机型/各 DSM 版本的交叉工具链。**前提**:已在 WSL2 里装好 Linux 发行版,并 clone 了 spksrc 仓库。

1. 管理员 PowerShell 安装 WSL2:`wsl --install -d Ubuntu`(首次可能要重启);
2. 进入 Ubuntu,克隆仓库:`git clone https://github.com/SynoCommunity/spksrc`;
3. 在页面上「构建方式」选 **spksrc**,填:
   - WSL 发行版:默认 `Ubuntu`
   - DSM 版本:如 `7.2`
   - spksrc 目录:如 `~/spksrc`
   - 包名:`spk/` 下的目录名,如 `transmission`、`ffmpeg`
4. 勾选目标架构(自动映射:x86_64→x64、arm64→aarch64、armv7→armv7),点构建。

产物由 spksrc 直接生成并自动拷回 Windows 的 `output/` 目录,可直接下载。

> spksrc 官方 Docker 方案不支持 Windows(符号链接/权限问题),所以这里通过 WSL2 的原生构建来跑。

## 导入 .spk 解包 + 二次打包

页面顶部「📥 导入 .spk 解包」支持两种方式:

- 选择本地 `.spk` 文件上传;或
- 填本地路径(如 `C:\path\to\foo.spk`)。

点击「解包」后,会自动:

1. 拆包到 `output/_imported/<包名>/`:
   - 外层文件(INFO、package.tgz、scripts/、图标、conf/ 等)放在该目录根;
   - 内层 `package.tgz` 解到 `target/` 子目录;
2. **把解析出的 INFO 元信息(名称/版本/描述/维护者等)自动填入下方「套件信息」表单**;
3. 自动切到「预编译」方式,并把「源目录」指向解包目录。

你只需改一下表单(比如改版本号、描述),直接点「构建」即可**二次打包**成新的 .spk;scripts/图标/conf/WIZARD_UIFILES 等外层资源都会原样保留。

## 与 sspks 套件服务器配合

把生成的 `.spk` 丢进你 [sspks](https://github.com/jdel/sspks) 服务器的 `packages` 目录,群晖**套件中心 → 套件来源**填上服务器地址即可安装。

> DSM 7 手动安装第三方未签名包时,需在套件中心设置里把「信任级别」改为**任意发布者**。

## 目录结构

```
spk-builder/
├── server.py      # 后端服务(HTTP + 构建任务 + 产物下载)
├── spkpack.py     # 打包核心(生成 INFO/scripts/package.tgz/.spk)
├── builders.py    # 构建提供者与工具链检测
├── web/           # 前端界面(index.html / app.js / style.css)
├── run.bat        # 一键启动(Windows)
├── output/        # 构建产物(运行时生成)
└── tools/         # (可选)便携工具链,如 Go
```

## 常见问题

- **Go 未安装**:界面顶部会显示红色徽标。安装 Go 后重启本工具即可。
- **Docker 未安装**:仅影响“Docker”构建方式,打包与 Go/本地命令不受影响。
- **运行身份 root / 非 root**:构建页「④ 运行配置」里选。选「非 root」会生成 `conf/privilege`(DSM 7 推荐非 root 运行);选「root」则以最高权限运行。
- **产物下载路径**:下载链接指向 `output/` 下相对路径,文件名按 `<名称>-<架构>-<版本>.spk` 命名。
