#!/usr/bin/env python3
import json
import sys

from PIL import Image, ImageDraw, ImageFont


def main():
    request = json.loads(sys.stdin.read())
    image = Image.open(request["image"]).convert("RGB")
    origin_x, origin_y = request["origin"]
    scale = request.get("scale", 1.0)
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", max(10, int(11 * scale)))
    except OSError:
        font = ImageFont.load_default()
    for element in request["elements"]:
        x, y, w, h = element["bounds"]
        box = [(x - origin_x) * scale, (y - origin_y) * scale, (x - origin_x + w) * scale, (y - origin_y + h) * scale]
        if box[2] < 0 or box[3] < 0 or box[0] > image.width or box[1] > image.height:
            continue
        color = (255, 64, 129) if element.get("interactive") else (66, 153, 255)
        draw.rectangle(box, outline=color, width=2)
        label = element["id"]
        text_box = draw.textbbox((0, 0), label, font=font)
        label_w, label_h = text_box[2] - text_box[0] + 6, text_box[3] - text_box[1] + 4
        lx, ly = max(0, box[0]), max(0, box[1] - label_h)
        draw.rectangle([lx, ly, lx + label_w, ly + label_h], fill=color)
        draw.text((lx + 3, ly + 1), label, fill=(255, 255, 255), font=font)
    image.save(request["out"])


if __name__ == "__main__":
    main()
