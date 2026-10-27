# -*- coding: utf-8 -*-
"""把 chart.json + song.mp3 注入模板，产出单文件 index.html"""
import base64, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
OUT = os.path.join(ROOT, "index.html")


def main():
    tpl = open(os.path.join(BUILD, "game.template.html"), encoding="utf-8").read()
    chart = json.load(open(os.path.join(BUILD, "chart.json"), encoding="utf-8"))
    mp3 = os.path.join(BUILD, "song.mp3")
    b64 = base64.b64encode(open(mp3, "rb").read()).decode("ascii")

    plat_css = open(os.path.join(BUILD, "platform.css"), encoding="utf-8").read()
    plat_js = open(os.path.join(BUILD, "platform.js"), encoding="utf-8").read()

    song_json = json.dumps(chart, ensure_ascii=False, separators=(",", ":"))
    html = (tpl.replace("__SONG_DATA__", song_json)
               .replace("__AUDIO__", "data:audio/mpeg;base64," + b64)
               .replace("__PLATFORM_CSS__", plat_css)
               .replace("__PLATFORM_JS__", plat_js)
               .replace("__COMPOSER__", chart["meta"].get("composer", ""))
               .replace("__LYRICIST__", chart["meta"].get("lyricist", "")))
    for tag in ("__SONG_DATA__", "__AUDIO__", "__PLATFORM_CSS__", "__PLATFORM_JS__"):
        assert tag not in html, "占位符未替换: " + tag

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"OK  {OUT}  {os.path.getsize(OUT)/1024/1024:.2f} MB")
    # 参考：分离资源版（可选，便于后续替换音轨）
    os.makedirs(os.path.join(ROOT, "audio"), exist_ok=True)
    with open(os.path.join(ROOT, "audio", "song.mp3"), "wb") as f:
        f.write(open(mp3, "rb").read())


if __name__ == "__main__":
    main()
