# -*- coding: utf-8 -*-
"""
离线谱面生成：解码音频 -> 起始点检测 -> 特征分析 -> 三难度谱面 -> chart.json
仅依赖 numpy + 外部 ffmpeg（FFMPEG_EXE 环境变量）
"""
import json, os, re, subprocess, sys, wave
import numpy as np

SR = 22050
FRAME = 1024
HOP = 256
FR = HOP / SR


def ffmpeg_exe():
    return os.environ.get("FFMPEG_EXE", "ffmpeg")


def decode(src, dst, sr=SR):
    subprocess.run([ffmpeg_exe(), "-y", "-v", "error", "-i", src, "-ac", "1",
                    "-ar", str(sr), "-f", "wav", "-acodec", "pcm_s16le", dst], check=True)
    with wave.open(dst, "rb") as w:
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    return data


def to_mp3(src, dst, kbps=128):
    subprocess.run([ffmpeg_exe(), "-y", "-v", "error", "-i", src, "-ac", "2",
                    "-ar", "44100", "-b:a", f"{kbps}k", dst], check=True)


def stft_mag(x):
    n = 1 + max(0, (len(x) - FRAME) // HOP)
    idx = np.arange(FRAME)[None, :] + HOP * np.arange(n)[:, None]
    frames = x[idx] * np.hanning(FRAME)[None, :]
    return np.abs(np.fft.rfft(frames, axis=1)).astype(np.float32)


def band_matrix(sr=SR, banks=28, fmin=40.0, fmax=9000.0):
    freqs = np.fft.rfftfreq(FRAME, 1.0 / sr)
    edges = np.geomspace(fmin, fmax, banks + 1)
    M = np.zeros((banks, len(freqs)), dtype=np.float32)
    for i in range(banks):
        lo, hi = edges[i], edges[i + 1]
        sel = (freqs >= lo) & (freqs < hi)
        if not sel.any():
            M[i, int(np.argmin(np.abs(freqs - (lo + hi) / 2)))] = 1.0
        else:
            M[i, sel] = 1.0
    return M, freqs


def onset_env(spec, M):
    band = spec @ M.T
    logband = np.log1p(band * 20.0)
    d = np.diff(logband, axis=0, prepend=logband[:1])
    flux = np.maximum(d, 0).sum(axis=1)
    k = np.array([1, 2, 3, 2, 1], dtype=np.float32); k /= k.sum()
    flux = np.convolve(flux, k, mode="same")
    win = int(0.5 / FR) | 1
    pad = win // 2
    p = np.pad(flux, (pad, pad), mode="edge")
    local = np.convolve(p, np.ones(win, dtype=np.float32) / win, mode="valid")[:len(flux)] + 1e-6
    env = np.clip((flux / local - 1.0) / 2.5, 0, None)
    return (env / (env.max() + 1e-9)).astype(np.float32), band


def peak_pick(env, min_gap_s=0.08, thr=0.07):
    peaks, gap = [], int(min_gap_s / FR)
    for i in range(1, len(env) - 1):
        if env[i] < thr:
            continue
        if env[i] >= env[i - 1] and env[i] >= env[i + 1]:
            if peaks and i - peaks[-1] < gap:
                if env[i] > env[peaks[-1]]:
                    peaks[-1] = i
            else:
                peaks.append(i)
    return peaks


def peak_features(env, band, peaks):
    feats = []
    for p in peaks:
        v = band[p]
        low = float(v[:8].sum()); mid = float(v[8:19].sum()); high = float(v[19:].sum())
        tot = low + mid + high + 1e-9
        feats.append({"t": p * FR, "p": p, "s": float(env[p]),
                      "low": low / tot, "high": high / tot})
    return feats


def pct_rank(values):
    order = np.argsort(np.argsort(np.asarray(values)))
    return order / max(1, len(values) - 1)


def build_chart(feats, diff, dur):
    cfg = {
        "easy":   {"target": 152, "gap": 0.50, "hold_max": 10},
        "normal": {"target": 262, "gap": 0.185, "hold_max": 16},
        "hard":   {"target": 470, "gap": 0.105, "hold_max": 24},
    }[diff]
    lo_t, hi_t = 3.2, dur - 1.6
    pool = [f for f in feats if lo_t <= f["t"] <= hi_t]
    if not pool:
        return []

    # 按 2s 窗口分配音符数（跟随能量密度，避免某段过空）
    W = 2.0
    wins = {}
    for f in pool:
        wins.setdefault(int(f["t"] // W), []).append(f)
    weights = {k: sum(x["s"] for x in v) * (1 + 0.35 * len(v)) for k, v in wins.items()}
    tw = sum(weights.values()) or 1.0

    chosen = []
    for k, arr in wins.items():
        n = max(1, int(round(cfg["target"] * weights[k] / tw)))
        arr = sorted(arr, key=lambda x: -x["s"])[:n]
        chosen.extend(arr)
    chosen.sort(key=lambda x: x["t"])

    # 全局最小间隔
    picked = []
    for f in chosen:
        if picked and f["t"] - picked[-1]["t"] < cfg["gap"]:
            if f["s"] > picked[-1]["s"] * 1.3:
                picked[-1] = f
            continue
        picked.append(f)

    # 亮度 -> 轨道（分位 + 均衡 + 连击限制）
    bright = np.array([f["high"] / (f["low"] + f["high"] + 1e-9) for f in picked])
    rank = pct_rank(bright)
    counts = [0, 0, 0, 0]
    notes, last_lane, run = [], -1, 0
    for i, f in enumerate(picked):
        r = rank[i]
        lane = 0 if r < 0.25 else 1 if r < 0.5 else 2 if r < 0.75 else 3
        if counts[lane] > (len(picked) / 4) * 1.22:
            alt = int(np.argmin(counts))
            if abs(alt - lane) <= 1:
                lane = alt
        if lane == last_lane:
            run += 1
            if run >= 2:
                lane = lane + 1 if lane < 3 else lane - 1
                run = 0
        else:
            run = 0
        counts[lane] += 1
        notes.append({"t": round(f["t"], 3), "lane": lane, "hold": 0.0, "s": f["s"]})
        last_lane = lane

    # 长按：强音 + 后方空档
    if cfg["hold_max"] > 0 and len(notes) > 4:
        thr = np.percentile([n["s"] for n in notes], 78)
        cand = [i for i in range(len(notes) - 1)
                if notes[i]["s"] >= thr and notes[i + 1]["t"] - notes[i]["t"] > 0.58]
        cand.sort(key=lambda i: -notes[i]["s"])
        chosen_i = []
        for i in cand:
            if len(chosen_i) >= cfg["hold_max"]:
                break
            if any(abs(i - j) < 6 for j in chosen_i):
                continue
            chosen_i.append(i)
            gap = notes[i + 1]["t"] - notes[i]["t"]
            notes[i]["hold"] = round(min(0.6, gap * 0.5), 2)
    return notes


def parse_lrc(path):
    txt = open(path, "r", encoding="utf-8-sig", errors="ignore").read()
    lines, meta = [], {}
    for raw in txt.splitlines():
        m = re.match(r"\[(\d+):(\d+)[.:](\d+)\](.*)", raw.strip())
        if not m:
            continue
        mm, ss, xx, text = m.groups()
        t = int(mm) * 60 + int(ss) + int(xx) / (100 if len(xx) == 2 else 1000)
        text = text.strip()
        if not text:
            continue
        if text.startswith("作曲"):
            meta["composer"] = re.split(r"[：:]", text)[-1].strip(); continue
        if text.startswith("作词"):
            meta["lyricist"] = re.split(r"[：:]", text)[-1].strip(); continue
        lines.append({"t": round(t, 2), "text": text})
    return lines, meta


def main():
    audio, lrc, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(out_dir, exist_ok=True)
    wav = os.path.join(out_dir, "tmp.wav")
    mp3 = os.path.join(out_dir, "song.mp3")

    print("[1/5] 解码音频")
    x = decode(audio, wav)
    dur = len(x) / SR
    print(f"      时长 {dur:.2f}s")

    print("[2/5] 频谱 / 起始点")
    spec = stft_mag(x)
    M, _ = band_matrix()
    env, band = onset_env(spec, M)
    peaks = peak_pick(env)
    feats = peak_features(env, band, peaks)
    print(f"      起始点 {len(feats)}  强度中位数 {np.median([f['s'] for f in feats]):.2f}")

    print("[3/5] 速度估计")
    e = env - env.mean()
    ac = np.correlate(e, e, mode="full")[len(e) - 1:]
    lo, hi = int(0.30 / FR), int(1.10 / FR)
    k = int(np.argmax(ac[lo:hi])) + lo
    bpm = 60.0 / (k * FR)
    if bpm < 80:
        bpm *= 2
    print(f"      BPM ≈ {bpm:.1f}")

    print("[4/5] 生成三难度谱面")
    charts, stats = {}, {}
    for d in ("easy", "normal", "hard"):
        c = build_chart(feats, d, dur)
        charts[d] = [[float(n["t"]), int(n["lane"]), float(n["hold"])] for n in c]
        span = (c[-1]["t"] - c[0]["t"]) if c else 1
        stats[d] = {"notes": len(c), "holds": sum(1 for n in c if n["hold"]),
                    "first": float(c[0]["t"]) if c else 0.0,
                    "last": float(c[-1]["t"]) if c else 0.0,
                    "nps": round(len(c) / max(1e-6, span), 2)}
        lanes = [0, 0, 0, 0]
        for n in c:
            lanes[n["lane"]] += 1
        print(f"      {d:6s} {stats[d]['notes']:4d} notes  holds {stats[d]['holds']:2d}  "
              f"nps {stats[d]['nps']:.2f}  lanes {lanes}")

    lyrics, meta = parse_lrc(lrc)
    _acc_thr = float(np.percentile([f["s"] for f in feats], 88))
    accents = sorted({round(f["t"], 2) for f in feats if f["s"] >= _acc_thr and 3.0 < f["t"] < dur - 1.5})
    print(f"      歌词 {len(lyrics)} 行  重音 {len(accents)}")

    print("[5/5] 导出")
    to_mp3(audio, mp3)
    data = {
        "meta": {"title": "嘶恍而过的青葱岁月", "composer": meta.get("composer", ""),
                 "lyricist": meta.get("lyricist", ""), "bpm": round(bpm, 1),
                 "duration": round(dur, 3), "offset": 0, "stats": stats},
        "lyrics": lyrics, "accents": accents, "charts": charts,
    }
    with open(os.path.join(out_dir, "chart.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"), default=float)
    os.remove(wav)
    print("      完成", os.path.join(out_dir, "chart.json"))


if __name__ == "__main__":
    main()
