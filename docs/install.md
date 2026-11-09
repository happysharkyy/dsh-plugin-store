# 内网安装指南

> 面向使用插件的开发人员。整个流程不需要访问 GitHub 或 npm。

## 0. 前提

- 本机已安装 DSH（桌面端或 `dsh` CLI 均可）
- 知道要装进哪个 profile：Web 界面用 `web`，终端界面用 `tui`
- 能访问插件商店地址，例如 `http://dsh-store.corp.local:8787`

商店部署在内网，**安装全程不需要外网**：安装包里已经带好全部运行时依赖，`dsh plugin` 不会访问 npm 仓库。

个别插件在**运行**时还需要额外准备（页面上标着「需预热」）：Docling 要预先拉好模型权重，MinerU 要有一个内网可访问的解析服务。装之前先看详情页的「断网注意」。

## 1. 安装

### Linux / macOS

**推荐：下载后安装**（任何环境都能用）

```bash
curl -O http://dsh-store.corp.local:8787/packages/remote-workspace-0.8.72.tgz
dsh plugin --profile web add ./remote-workspace-0.8.72.tgz
```

也可以在页面点「下载 .tgz」，再在下载目录执行第二条。

**直接安装**（要求这台机器能访问商店地址）

```bash
dsh plugin --profile web add http://dsh-store.corp.local:8787/packages/remote-workspace-0.8.72.tgz
```

> 直接安装报错时别纠结，改用上面的两条命令即可。常见报错见第 4 节。

### Windows

```powershell
# 推荐（curl 自带于 Win10+）
curl.exe -O http://dsh-store.corp.local:8787/packages/office-suite-0.2.5.tgz
dsh plugin --profile web add .\office-suite-0.2.5.tgz

# 或直接装
dsh plugin --profile web add http://dsh-store.corp.local:8787/packages/office-suite-0.2.5.tgz
```

`dsh plugin` 会把参数原样转交给 profile 目录里的 pnpm，所以任何 pnpm 能识别的写法都能用。

### 直接安装失败时看这里

| 报错 | 含义 | 解决 |
| --- | --- | --- |
| `ERR_PNPM_FETCH_404` / `404 Not Found` | 商店地址在这台机器上不可达，或包名拼错 | 换成下载后安装 |
| `ETIMEDOUT` / `ECONNREFUSED` | 网络不通（防火墙、地址写成了 127.0.0.1） | 换成下载后安装；或确认商店端口已放通 |
| `EAI_AGAIN` / `getaddrinfo` | 主机名解析不了 | 用 IP 代替主机名 |
| `installation rejected: ... incompatible` | DSH 版本门槛，与网络无关 | 见下面第 5 节 |

确认可达性：

```bash
curl -I http://dsh-store.corp.local:8787/api/health
```

返回 200 才说明这台机器能直连商店。

## 2. 生效

安装完成后**重启 DSH**：

```bash
dsh web
```

DSH 在启动时按 profile 的 `package.json` 组合插件树，运行中不会热加载新装插件。

## 3. 验证安装结果

```bash
dsh --profile web --dump-config
```

配置树里出现新插件的条目即表示装配成功。

## 4. 卸载

```bash
dsh plugin --profile web remove dsh-remote-ssh
```

包名可以在商店详情页看到（`package` 字段）。

## 5. 常见问题

**Q：报错 `pnpm` 不存在？**

`dsh plugin` 依赖 pnpm。DSH 桌面端自带一份 pnpm，通常不需要额外安装；纯 CLI 环境请确认 pnpm 在 PATH 上。

**Q：安装时还在联网 / 卡住？**

说明拿到的不是商店里的离线包。商店的包已经把运行时依赖打进 `node_modules` 并从 `package.json` 移除了 `dependencies`，正常安装不会访问 registry。请确认用的是商店的 `/packages/xxx.tgz`。

**Q：`Unsupported URL Type "workspace:"`？**

这是 `npm install` 直接装源码仓库的典型报错，说明没用商店的 tgz。

**Q：`installation rejected: Plugin xxx is incompatible with dsh yyy`？**

插件声明的 DSH 版本范围与当前运行时对不上，DSH 主动拒绝加载（这是保护，不是 bug）。两条路：

1. 升级 DSH 到插件要求的版本；
2. 确认风险后显式豁免：

```bash
dsh plugin --profile web allow-version <包名>@<版本> --dsh-version <当前版本> --accept-risk
dsh plugin --profile web add <商店包地址>
```

商店详情页的橙色提示条会写明哪些插件需要这一步。

**Q：装完重启后插件没生效？**

先看 `dsh --profile web --dump-config` 里有没有该插件；没有的话说明 profile 的 `dsh.profile.bundles` 里没登记，通常是包内缺少 `cordis.patch.yml`，找商店维护者重新打包。

**Q：Linux 上装完启动报原生模块错误？**

包是为特定平台构建的。商店里的是 **linux-x64（适配 CentOS 7 / glibc 2.17）** 的包；如果机器是 arm64、或者用不了 glibc 2.17 的构建，需要让维护者提供对应平台的重建包。

已知：`ssh2` 的原生加速件在 glibc 2.17 上会加载失败，插件已剔除它并自动退回纯 JS 实现——功能不受影响，只是 SSH 加解密稍慢。

## 6. 校验安装包（可选）

商店详情页给出每个包的 SHA-256。

```bash
sha256sum remote-workspace-0.8.72.tgz          # Linux
Get-FileHash .\remote-workspace-0.8.72.tgz -Algorithm SHA256   # Windows
```

与页面上显示的值比对，一致即可放心安装。
