# dsh-chatting-pet

会说话、会记事、会自己找话题的 DSH 桌宠。基于 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT）的 fork，内置：

- **语音输出**：Edge 神经语音（免费）/ 阿里云百炼（可选，更会表达情绪）
- **语音聊天**：长按 `C`（可改键）或右键桌宠说话 → 识别 → 桌宠语音回复
- **闲聊模式**：主动搭话；关着时每 1–2 分钟、开着时每 30 秒掷 50%
- **记忆库**：聊天记忆、桌面观察、B站视频、QQ 群记忆
- **人格系统**：内置大肥鱼 / 爱莉希雅，支持导入 `.md`、`.txt`、酒馆 v2 角色卡
- **B站自刷**：设置里扫码绑定，自己拉热门视频，日报进记忆（不依赖 bili-scroll）
- **QQ 人设/记忆**：填 QQ 群号/私聊号即可套用 qq-groupmate 的角色与群聊记忆

## 安装

```powershell
dsh plugin --profile desktop add dsh-chatting-pet
```

或从 GitHub：

```powershell
dsh plugin --profile desktop add github:flhy666/dsh-chatting-pet
```

装完重启 DSH。桌面宠物使用 `%DSH_HOME%\dsh-pet\` 作为配置目录（与 dsh-pet 兼容，可与原版互斥安装）。

## 首次配置

打开 **设置 → 桌宠配置** 最下面的「语音」卡片：

1. **语音朗读**：开关
2. **音色**：Edge 免费；阿里云可以直接在设置里填「阿里云 API Key」（存在 `%DSH_HOME%\dsh-chatting-pet\voice\cloud.json`）
3. **人格**：选内置或导入角色卡
4. **B站**：点「绑定 B站账号」扫码；不绑定也能刷热门
5. **QQ号**：填群号/私聊号，套用 qq-groupmate 人设与群记忆
6. **闲聊模式**：右键桌宠或设置里开关；关闭也会主动找你，只是间隔更长

数据目录：`%DSH_HOME%\dsh-chatting-pet\voice\`（语音/记忆/B站凭证）。桌宠配置仍写 `%DSH_HOME%\dsh-pet\main-config.jsonc`。

## 隐私

- 桌面观察只读：窗口标题 + OCR 文字，不截图上传、不点击
- B站凭证只存本地；QQ 记忆只读本地文件
- 所有模型调用都走你自己 DSH 里配置的模型，不经过作者

## 许可证

MIT。原项目 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) © PC2005-cloud；本 fork 的语音/人格/记忆/B站部分由 flhy666 维护。
