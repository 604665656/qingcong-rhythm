# -*- coding: utf-8 -*-
"""把 chart.json + song.mp3 注入模板，产出两份：
   1) index.html      单文件版（音轨内嵌 base64，离线双击即玩 / 适合 itch.io）
   2) dist/           分包版（index.html + song.mp3，index.html 仅 ~150KB）
                      B 站 Toy 限制「index.html 解压后 ≤ 1MB」，必须用这一版
"""
import base64, json, os, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
OUT = os.path.join(ROOT, "index.html")
DIST = os.path.join(ROOT, "dist")

TAGS = ("__SONG_DATA__", "__AUDIO__", "__PLATFORM_CSS__", "__PLATFORM_JS__")


def render(tpl, chart, plat_css, plat_js, audio_value):
    html = (tpl.replace("__SONG_DATA__", chart)
               .replace("__AUDIO__", audio_value)
               .replace("__PLATFORM_CSS__", plat_css)
               .replace("__PLATFORM_JS__", plat_js))
    for tag in TAGS:
        assert tag not in html, "占位符未替换: " + tag
    return html


def inject_up(html):
    """UP 主头像内嵌 data URI（约 3KB）。

    B 站 api.bilibili.com 未开放 CORS，浏览器直连取不到，所以头像必须随包内置，
    联网时再尝试刷新。素材缺失时退化为透明占位，不能让 img 变裂图。"""
    av = os.path.join(BUILD, "up_avatar.webp")
    if os.path.exists(av):
        b = base64.b64encode(open(av, "rb").read()).decode("ascii")
        return html.replace("__UP_AVATAR__", "data:image/webp;base64," + b)
    return html.replace("__UP_AVATAR__", "")


def main():
    tpl = open(os.path.join(BUILD, "game.template.html"), encoding="utf-8").read()
    chart_raw = json.load(open(os.path.join(BUILD, "chart.json"), encoding="utf-8"))
    mp3 = os.path.join(BUILD, "song.mp3")
    b64 = base64.b64encode(open(mp3, "rb").read()).decode("ascii")

    plat_css = open(os.path.join(BUILD, "platform.css"), encoding="utf-8").read()
    plat_js = open(os.path.join(BUILD, "platform.js"), encoding="utf-8").read()

    chart_json = json.dumps(chart_raw, ensure_ascii=False, separators=(",", ":"))

    # 元数据取第一首（当前只有一首；多歌曲时每首自带 meta）
    song0 = chart_raw["songs"][0] if chart_raw.get("songs") else chart_raw
    meta0 = song0.get("meta", {})

    # ---------- 1) 单文件版 ----------
    single = render(tpl, chart_json, plat_css, plat_js, "data:audio/mpeg;base64," + b64)
    single = (single.replace("__COMPOSER__", meta0.get("composer", ""))
                    .replace("__LYRICIST__", meta0.get("lyricist", "")))
    single = inject_up(single)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(single)
    print("OK  单文件  %s  %.2f MB" % (OUT, os.path.getsize(OUT) / 1024 / 1024))

    # ---------- 2) 分包版（Toy 用） ----------
    # 注意：不要用 shutil.rmtree 删整个目录（会被本机 safe-delete 安全删除拦截，
    # 报 [safe-delete][SAFE_DELETE_FAIL_CLOSED] trash-failed），只逐个覆盖产物文件。
    os.makedirs(DIST, exist_ok=True)
    for name in ("index.html", "song.mp3"):
        p = os.path.join(DIST, name)
        if os.path.exists(p):
            os.remove(p)
    split = render(tpl, chart_json, plat_css, plat_js, "song.mp3")
    split = (split.replace("__COMPOSER__", meta0.get("composer", ""))
                  .replace("__LYRICIST__", meta0.get("lyricist", "")))
    split = inject_up(split)
    with open(os.path.join(DIST, "index.html"), "w", encoding="utf-8") as f:
        f.write(split)
    shutil.copyfile(mp3, os.path.join(DIST, "song.mp3"))
    size_html = os.path.getsize(os.path.join(DIST, "index.html"))
    size_mp3 = os.path.getsize(os.path.join(DIST, "song.mp3"))
    print("OK  分包     dist/index.html  %.1f KB   dist/song.mp3  %.2f MB"
          % (size_html / 1024, size_mp3 / 1024 / 1024))
    if size_html > 1024 * 1024:
        print("!! dist/index.html 超过 1MB，Toy 会拒收", file=sys.stderr)

    # 参考：分离资源版（便于替换音轨）
    os.makedirs(os.path.join(ROOT, "audio"), exist_ok=True)
    shutil.copyfile(mp3, os.path.join(ROOT, "audio", "song.mp3"))


if __name__ == "__main__":
    main()
