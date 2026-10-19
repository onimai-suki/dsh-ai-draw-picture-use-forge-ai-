# 小鲸鱼画板 · dsh-image-gen

本地 AI 绘图接入 DeepSeek Harness：**模型自己写提示词 → 本地 Stable Diffusion WebUI / Forge 渲染 → 图片直接出现在对话里**。

> 在「已安装插件」里搜 **小鲸鱼画板**（包名 `dsh-image-gen`，行 id `dsh-image-gen`）就能找到它。

## 它给了什么

| 东西 | 说明 |
| --- | --- |
| `generate_image` 工具 | 模型把用户的话转成英文提示词并出图，结果以图片内容块返回，所以对话里能看到，模型也能看到。每张图同时存一份到插件数据目录的 `gallery/`。 |
| `image_gen_info` 工具 | 探测接口是否可用、当前 checkpoint、可用模型与采样器 —— 写提示词前知道该用动漫 tag 还是写实 tag。 |
| 绘图小卡片 | 输入框上方只留一枚**状态小胶囊**（连接状态 + 当前模型，点一下重新检查）。所有设置都在 **设置 → 小鲸鱼画板**：① 连接（接口地址 + 检查）② 模型下拉 + `↻` ③ 启动路径 + `▶ 启动` ④ 保存到目录 + `浏览…` ⑤ 必加词 / 必加反向词 ⑥ LoRA + 权重、嵌入、超网络 + `↻` ⑦ 生成默认值（宽×高、步数、CFG）。 |
| 生成时自动拼装 | 提示词顺序：你的 prompt → 必加词 → 风格 tag → `embedding:名字` → `<lora:名字:权重>`；必加反向词拼在负向词末尾；超网络走 `override_settings.sd_hypernetwork`（只影响这一次请求）。调用没给宽高/步数/CFG 时用设置里的默认值。 |
| 保存文件 | 所有设置一次保存进**插件根目录的 `save`**（JSON：`endpoint` / `launcher` / `saveDir` / `alwaysPrompt` / `alwaysNegative` / `lora` / `loraWeight` / `embedding` / `hypernetwork` / `defaultWidth` / `defaultHeight` / `defaultSteps` / `defaultCfg`），下次启动读它恢复。 |

## 安装

在 DSH 里用 `plugin_manager` 安装本目录（本地链接安装）：

```json
{ "action": "install_bundle", "target": "F:\\deepseek harness work staion\\dsh-image-gen" }
```

## 配置

- 接口地址与启动路径存在插件根目录的 `save` 文件里；缺失时回退到 `$DSH_HOME/image-gen/settings.json`（旧版位置）→ 环境变量 `DSH_IMAGE_GEN_ENDPOINT` → 默认 `http://127.0.0.1:7860`。
- WebUI / Forge 需要带 `--api` 启动。
- 生成超时 15 分钟（会排队，别急着判死）；切换模型超时 3 分钟；启动等待最长 3 分钟。
- 启动路径支持 `.bat` / `.cmd`（用 `start` 开新窗口，能看到服务日志）、`.ps1`、`.py`（用 `DSH_IMAGE_GEN_PYTHON` 或 `python`）、`.exe`。
- 「保存到」留空表示只存插件相册（`$DSH_HOME/image-gen/gallery`）；填了就每张再复制一份过去（文件名 `img-<时间>-<seed>.png`）。目录不存在会自动创建，不可写会明确报错。

## 路由

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/image-gen/settings` | 当前地址 + 可达性 + 当前模型 |
| POST | `/api/image-gen/settings` | `{endpoint}` 保存地址并重新探测 |
| POST | `/api/image-gen/check` | 只探测 |
| GET | `/api/image-gen/models` | 扫描全部 checkpoint |
| POST | `/api/image-gen/model` | `{name}` 切换 checkpoint（写 `sd_model_checkpoint`）|
| GET | `/api/image-gen/extras` | 扫描 LoRA / 嵌入 / 超网络 |
| POST | `/api/image-gen/launch` | `{launcher?}` 拉起应用并等到接口可用 |

## 出图参数默认值

`width=512, height=768, steps=28, cfg_scale=7, count=1, seed=-1`，负向提示词内置一套通用的解剖/画质防线。
`style` 可选 `anime / illustration / realistic / photo / watercolor / pixel / 3d / sketch`，只是往提示词后面追加 tag。

## 文件

```
index.js           Host：两个工具 + /api/image-gen 路由 + 设置读写
client.js          Client：conversation.input.dock 里的地址输入框
cordis.patch.yml   bundle patch（插入一行）
locale/{en,zh}.json 显示用标题/描述
icon.svg           插件图标
```
