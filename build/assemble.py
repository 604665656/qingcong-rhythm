# -*- coding: utf-8 -*-
"""把 CDP 录屏帧 + 音轨合成演示视频（帧时长按真实时间戳，避免漂移）"""
import json, os, subprocess, sys

FF = os.environ.get("FFMPEG_EXE", "ffmpeg")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    frames_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "build", "frames2")
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "deliver", "青葱岁月_音游演示.mp4")
    audio = os.path.join(ROOT, "audio", "song.mp3")
    start = float(sys.argv[3]) if len(sys.argv) > 3 else 50.8   # 音频起点 = 视频第一帧对应的歌曲时间
    dur = float(sys.argv[4]) if len(sys.argv) > 4 else 29.5

    ts = json.load(open(os.path.join(frames_dir, "frames.json")))
    files = sorted(f for f in os.listdir(frames_dir) if f.endswith(".jpg"))
    n = min(len(ts), len(files))
    lines = []
    for i in range(n):
        d = (ts[i + 1] - ts[i]) if i + 1 < n else 0.08
        d = max(0.01, min(d, 0.25))
        lines.append(f"file '{files[i]}'\nduration {d:.4f}")
    lines.append(f"file '{files[-1]}'")
    cfg = os.path.abspath(os.path.join(frames_dir, "concat.txt"))
    open(cfg, "w", encoding="utf-8").write("\n".join(lines))

    os.makedirs(os.path.dirname(out), exist_ok=True)
    cmd = [FF, "-y", "-v", "warning",
           "-f", "concat", "-safe", "0", "-i", cfg,
           "-ss", f"{start}", "-t", f"{dur}", "-i", audio,
           "-vf", f"fps=30,fade=t=in:st=0:d=0.5,fade=t=out:st={dur-1.0}:d=1.0,format=yuv420p",
           "-c:v", "libx264", "-preset", "medium", "-crf", "20",
           "-c:a", "aac", "-b:a", "192k", "-ac", "2",
           "-t", f"{dur}", "-shortest", "-movflags", "+faststart", out]
    print("frames:", n, "->", out)
    r = subprocess.run(cmd, cwd=frames_dir, capture_output=True, text=True)
    if r.returncode != 0:
        print("FFMPEG FAIL", r.returncode)
        print(r.stderr[-3000:])
        raise SystemExit(1)
    print("done", os.path.getsize(out) / 1024 / 1024, "MB")


if __name__ == "__main__":
    main()
