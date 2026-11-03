"""画项目 banner：README 头图（1600x400）与 GitHub social preview（1280x640）。

配色取自论文里的范式图：米白底、近黑字、一种蓝做重音。
用 2 倍尺寸绘制再缩小，避免锯齿。

依赖 Pillow：`python -m pip install pillow`
字体按平台找：Windows 用 Arial + 微软雅黑，Linux 用 DejaVu + Noto，macOS 用 Arial + PingFang。

用法：python assets/make-banner.py   # 输出 assets/banner.png 与 assets/social-preview.png
"""
import os

from PIL import Image, ImageDraw, ImageFont

BG = (246, 243, 236)
INK = (17, 17, 17)
BLUE = (21, 80, 200)
GRAY = (122, 118, 110)
LINE = (208, 202, 192)
WHITE = (255, 255, 255)

FONTS = {
    "latin_bold": [
        "C:/Windows/Fonts/arialbd.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    ],
    "latin": [
        "C:/Windows/Fonts/arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ],
    "cjk_bold": [
        "C:/Windows/Fonts/msyhbd.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/System/Library/Fonts/PingFang.ttc",
    ],
    "cjk": [
        "C:/Windows/Fonts/msyh.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/System/Library/Fonts/PingFang.ttc",
    ],
}

SCALE = 2


def pick(kind):
    for path in FONTS[kind]:
        if os.path.exists(path):
            return path
    raise SystemExit(f"找不到 {kind} 字体，试过：{', '.join(FONTS[kind])}")


def font(kind, size):
    return ImageFont.truetype(pick(kind), int(size * SCALE))


def rounded(draw, box, radius, fill=None, outline=None, width=1):
    draw.rounded_rectangle(
        [box[0] * SCALE, box[1] * SCALE, box[2] * SCALE, box[3] * SCALE],
        radius=radius * SCALE,
        fill=fill,
        outline=outline,
        width=int(width * SCALE),
    )


def arrow(draw, start, end, color, width=2, head=9):
    draw.line([start[0] * SCALE, start[1] * SCALE, end[0] * SCALE, end[1] * SCALE], fill=color, width=int(width * SCALE))
    dx, dy = end[0] - start[0], end[1] - start[1]
    length = max((dx * dx + dy * dy) ** 0.5, 1e-6)
    ux, uy = dx / length, dy / length
    px, py = -uy, ux
    tip = (end[0] * SCALE, end[1] * SCALE)
    left = ((end[0] - ux * head + px * head * 0.62) * SCALE, (end[1] - uy * head + py * head * 0.62) * SCALE)
    right = ((end[0] - ux * head - px * head * 0.62) * SCALE, (end[1] - uy * head - py * head * 0.62) * SCALE)
    draw.polygon([tip, left, right], fill=color)


def boxes(draw, start_x, top, width=160, height=64, gap=40, label_size=26):
    """三个盒子：思考 → 行动 → 观察（蓝色）。返回各盒子中心点。"""
    centers = []
    for index, (label, blue) in enumerate([("思考", False), ("行动", False), ("观察", True)]):
        x0 = start_x + index * (width + gap)
        rounded(draw, (x0, top, x0 + width, top + height), 12, fill=BLUE if blue else WHITE, outline=None if blue else LINE)
        draw.text(
            ((x0 + width / 2) * SCALE, (top + height / 2) * SCALE),
            label,
            font=font("cjk_bold", label_size),
            fill=WHITE if blue else INK,
            anchor="mm",
        )
        centers.append((x0 + width / 2, top + height / 2))
        if index < 2:
            arrow(draw, (x0 + width + 4, top + height / 2), (x0 + width + gap - 4, top + height / 2), GRAY)
    return centers


def loop_back(draw, centers, top_y, label="可循环"):
    """从「观察」顶部绕回「思考」顶部。"""
    first, last = centers[0], centers[2]
    draw.line([last[0] * SCALE, (last[1] - 32) * SCALE, last[0] * SCALE, top_y * SCALE], fill=BLUE, width=2 * SCALE)
    draw.line([last[0] * SCALE, top_y * SCALE, first[0] * SCALE, top_y * SCALE], fill=BLUE, width=2 * SCALE)
    arrow(draw, (first[0], top_y), (first[0], first[1] - 34), BLUE)
    draw.text(
        (((first[0] + last[0]) / 2) * SCALE, (top_y - 8) * SCALE), label, font=font("cjk", 15), fill=GRAY, anchor="mb"
    )


def banner(path, width=1600, height=400):
    canvas = Image.new("RGB", (width * SCALE, height * SCALE), BG)
    draw = ImageDraw.Draw(canvas)

    draw.text((96 * SCALE, 170 * SCALE), "ReActive", font=font("latin_bold", 118), fill=INK, anchor="ls")
    draw.text((98 * SCALE, 226 * SCALE), "本机感知 · 经验 · 多任务调度", font=font("cjk_bold", 30), fill=INK, anchor="ls")
    draw.text(
        (98 * SCALE, 268 * SCALE),
        "dsh-superagent · fork of deepseek-ai/dsh-superagent-prototype",
        font=font("latin", 17),
        fill=GRAY,
        anchor="ls",
    )

    centers = boxes(draw, start_x=930, top=176)
    loop_back(draw, centers, top_y=138)
    arrow(draw, (846, 208), (926, 208), BLUE)
    draw.text((846 * SCALE, 186 * SCALE), "MSP 推送", font=font("cjk", 16), fill=BLUE, anchor="ls")

    draw.line([96 * SCALE, 324 * SCALE, (width - 96) * SCALE, 324 * SCALE], fill=LINE, width=1 * SCALE)
    draw.text((96 * SCALE, 354 * SCALE), "ReActive is All PA Need", font=font("latin", 16), fill=GRAY, anchor="ls")
    draw.text(((width - 96) * SCALE, 354 * SCALE), "2026.11", font=font("latin", 16), fill=GRAY, anchor="rs")

    canvas.resize((width, height), Image.LANCZOS).save(path)
    print("saved", path, (width, height))


def social(path, width=1280, height=640):
    canvas = Image.new("RGB", (width * SCALE, height * SCALE), BG)
    draw = ImageDraw.Draw(canvas)
    center_x = width / 2

    draw.text((center_x * SCALE, 246 * SCALE), "ReActive", font=font("latin_bold", 128), fill=INK, anchor="ms")
    draw.text((center_x * SCALE, 312 * SCALE), "一个会「听」的 ReAct", font=font("cjk_bold", 38), fill=INK, anchor="ms")
    draw.text(
        (center_x * SCALE, 366 * SCALE),
        "本机感知（MSP）+ 经验（Experience）· 多任务调度",
        font=font("cjk", 24),
        fill=GRAY,
        anchor="ms",
    )

    block = 3 * 150 + 2 * 40
    centers = boxes(draw, start_x=(width - block) / 2, top=452, width=150, height=60, gap=40, label_size=24)
    loop_back(draw, centers, top_y=414)

    draw.line([80 * SCALE, 566 * SCALE, (width - 80) * SCALE, 566 * SCALE], fill=LINE, width=1 * SCALE)
    draw.text(
        (center_x * SCALE, 600 * SCALE),
        "hxh230802 / dsh-superagent-prototype · MIT",
        font=font("latin", 18),
        fill=GRAY,
        anchor="ms",
    )

    canvas.resize((width, height), Image.LANCZOS).save(path)
    print("saved", path, (width, height))


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    banner(os.path.join(here, "banner.png"))
    social(os.path.join(here, "social-preview.png"))
