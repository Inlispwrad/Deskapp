# apps/ —— 构建出来的应用都放这里

按**目标设备**分子目录，一台设备一个目录，互不覆盖：

```
apps/
  mac-arm64/       Apple Silicon
  mac-x64/         Intel Mac
  windows-x64/
  linux-x64/
```

目录名是 `${os}-${arch}`，由 electron-builder 的宏展开，导出功能也按同一规则拼。
所以在一台机器上交叉构建多个目标时不会互相踩。

## 什么会落到这里

| 来源 | 命令 | 产物 |
|---|---|---|
| Deskapp 自身 | `pnpm dist:mac` / `dist:win` / `dist:linux` | `Deskapp.app` / 安装包 |
| 任意项目导出 | `electron . --export <项目目录>` | `<项目名>.app` |

导出时不给 `--out` 就默认落到当前设备对应的那个子目录。

## 不进版本库

`.gitignore` 里排除了 `apps/` 下的所有内容（只留这份说明）。
一个 macOS 产物就 276MB，不该进 git —— 需要分发时用 `pnpm dist:*` 现构建。
