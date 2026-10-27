# 青葱岁月 · 网页音游引擎

一个不依赖任何框架、不依赖构建工具的单文件 Web 音游（4 轨下落式）。
最终产物是一个 `index.html`：内嵌音轨、谱面、矢量角色，双击即玩，可离线运行，也可直接压缩上传到 B 站 Toy。

> 本仓库开源的是**游戏引擎与构建流程**。示例曲目为第三方音乐作品，音轨与由其派生的谱面数据不入库，见「版权与授权」。
>
> 仓库地址：<https://github.com/604665656/qingcong-rhythm>

---

## 特性

**玩法**
- 4 轨下落式，`D F J K` / 方向键 / 触屏 / 手柄四种输入
- 判定窗口 PERFECT ±45ms · GREAT ±90ms · GOOD ±135ms · MISS ±180ms
- 长条音符（按住至条尾）、50 连击进入 FEVER ×1.5
- 三难度、准确率评级（SSS/SS/S/A/B/C）、本机最佳分

**谱面由音频分析离线生成，不套固定 BPM 网格**
1. ffmpeg 解码 → 22050Hz 单声道
2. STFT（frame 1024 / hop 256）+ 28 段对数频带 → 谱通量起始点检测
3. 每 2 秒窗口按能量分配音符配额，保证全曲密度均衡
4. 按频带亮度映射到 4 条轨道，做均衡与连打限制
5. 强音处且后方有空档 → 生成长条
6. 视觉重音脉冲同样取自音频重音点，而非固定节拍

自由节拍的流行曲实测节拍网格对齐率 < 25%，所以谱面跟着真实音头走。

**移动端 / 多端适配**
- 竖屏与横屏各自排版，旋转后多次重算视口（iOS 的 `orientationchange` 尺寸是延迟更新的）
- 触屏按住后横向滑动可连续触发相邻轨道（滑动连打）
- 多指互不干扰：每个 `pointerId` 独立记轨
- 用事件 `timeStamp` 换算歌曲时间并扣除触屏采样延迟，判定更"准手"
- 每次按下都有独立于判定的光环反馈，Miss 也能立刻看到手指生效
- 手柄：`A B X Y` / 十字键 / 左摇杆映射 4 轨，`Start` 暂停，`Back` 暂停，连接后左下角显示设备名

**平台层（B 站 Toy SDK）**
- 排行榜：`submitScore` / `getRankList` / `getMyRank`，三难度 × 总/月/周/日榜
- 云存档：`getCloudStorage` / `setCloudStorage`，本地 localStorage 与云端合并取更有利值
- 体力：上限 5 点、每 1 分钟恢复 1 点、每日 20 局上限、离线恢复按时间戳补算
- 分享得体力：分享后必须真实回到页面且 ≥5 秒，云端时间戳去重 + 每日 3 次上限 + 15 秒间隔
- 成绩校验：判定总数、准确率区间、分数理论上限、时长与 Miss 比例，不通过则不入库不上榜
- 所有 SDK 调用强制超时降级，非宿主环境下自动切换单机模式，绝不卡在加载页

**其它**
- 老板键：`Alt + X` / `` ` ``，手机上三指长按 500ms；伪装成 Excel 工作排期表
- 音频三级降级：WebAudio 解码 → `<audio>` + Blob URL → 静音试玩（performance 时钟走谱面）
- 健康游戏忠告：加载页、标题页、玩法面板三处常驻

---

## 目录

```
build/
  analyze.py          音频分析 + 谱面生成（需 numpy + ffmpeg）
  build.py            注入音轨/谱面/平台层 → 产出单文件 index.html
  game.template.html  游戏本体模板（UI、判定、绘制、输入、手柄）
  platform.css        Toy 平台层样式（体力/排行榜/分享/老板键）
  platform.js         Toy 平台层逻辑（SDK 封装、存档、防刷校验）
  assemble.py         录屏帧 + 音轨合成演示视频
  qa2.js              自动化自测（CDP 驱动无头浏览器，35 项）
  shots.js            多尺寸截图
  measure*.js         布局溢出自检
```

`index.html`、`build/song.mp3`、`build/chart.json` 都由构建生成，不入库。

---

## 快速开始

```bash
# 1) 准备音轨与歌词
#    song.m4a / song.lrc 放在任意位置

# 2) 分析音频、生成谱面（需要 numpy，ffmpeg 可用 FFMPEG_EXE 指定）
python build/analyze.py 你的音频.m4a 你的歌词.lrc build

# 3) 注入模板，产出两份
python build/build.py
# → index.html        单文件版 3.9MB，音轨内嵌，双击即玩 / 适合 itch.io
# → dist/             分包版 index.html 142KB + song.mp3 2.8MB，适合 B站 Toy
```

为什么要有两份：B 站 Toy 限制 **`index.html` 解压后 ≤ 1MB**，内嵌 base64 音轨会直接超限被拒（提示「请将内联的脚本、样式或图片拆成独立文件」）。分包版把音轨改成相对路径 `song.mp3`，正文只有 142KB。

`build.py` 会替换模板里的 `__SONG_DATA__` / `__AUDIO__` / `__PLATFORM_CSS__` / `__PLATFORM_JS__` 占位符，并断言四个都被替换干净。`__AUDIO__` 既可以是 `data:audio/mpeg;base64,...`，也可以是 `song.mp3` 这样的相对路径，前端两种都支持。

### 自测

```bash
node build/qa2.js      # 需要 Edge 或 Chrome，走 CDP 无头运行
node build/shots.js    # 生成桌面 / 竖屏 / 横屏 / 弹层截图
```

`qa2.js` 覆盖 35 项：加载、体力增减与离线恢复、每日上限、结算入库、异常分数拦截、排行榜与分享弹层、老板键、竖横屏重排、手柄映射、触屏点按/滑打/多指、健康忠告。

### 在手机上测

`file://` 打开时 iOS 可能禁止读取内嵌音频。用同网段的 http 服务最稳：

```bash
python -m http.server 8080
# 手机访问 http://<电脑内网IP>:8080/index.html
```

即使音频真的读不出来，页面也会给出「重试 / 静音试玩」两个按钮，不会一直卡在加载页。

---

## 打包上架 B 站 Toy

Toy 有两条硬限制，直接决定了产物形态：

- **`index.html` 解压后 ≤ 1MB** → 音轨不能内嵌（内嵌版 3.9MB），必须用 `dist/` 分包版
- **不允许内联脚本/样式/图片** → 但本项目脚本本来就在 `<script>` 里，真正超标的是 base64 音轨；拆出 `song.mp3` 后 index.html 仅 143KB，两条限制同时满足

```bash
python build/build.py      # 产出 dist/index.html + dist/song.mp3
# 把这两个文件放在同一层压成 zip，直接投 https://www.bilibili.com/toy/publish/
```

平台层会自动检测宿主：`window.toy` 存在 → 云端模式（排行榜/云存档/分享）；否则 → 单机模式，功能自动降级为本地存档。

---

## 两个已知的坑

**1. 本机代理会让本地自测连不上 127.0.0.1**

如果环境里设了 `HTTP_PROXY`，无头浏览器和 curl 会把 localhost 也走代理，结果是页面空白、`base` 探测全 false。自测时加 `NO_PROXY`：

```bash
NO_PROXY=1 PAGE_URL=https://… node build/qa2.js     # 或 http://127.0.0.1:8080/index.html
curl --noproxy '*' http://127.0.0.1:8080/index.html
```

**2. 带 `?sharecode=` 的分享链接会把静态资源也挡在参数后面**

`fetch("song.mp3")` 按相对路径解析时会丢掉查询串 → 音轨 403。`shareAwareUrl()` 会把当前页面的 `sharecode` 显式补回去；没有该参数的环境（Toy / itch.io / 本地）完全不受影响。分享时也别忘了带上 `?sharecode=`，只发域名会看到 403「链接不完整」。

---

## 版权与授权

- **代码**：MIT，见 `LICENSE`
- **角色形象**：按权利人授权**全新原创绘制**的 SVG 矢量插画，未使用任何原始图片素材
- **音乐**：示例曲目版权归原作者所有，本仓库不包含音轨及其派生谱面。自行替换为自己的音频或已获授权的作品；二次发布、商用请先取得授权
- **健康游戏忠告**：抵制不良游戏，拒绝盗版游戏。注意自我保护，谨防受骗上当。适度游戏益脑，沉迷游戏伤身。合理安排时间，享受健康生活。
