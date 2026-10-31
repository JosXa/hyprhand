#!/usr/bin/env python3
import json
import sys

from PIL import Image, ImageDraw, ImageFont


def annotate(request):
    image = Image.open(request["image"]).convert("RGB")
    origin_x, origin_y = request["origin"]
    scale = image.width / request["layout"][0]
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
    image.save(request["image"])
    return {"ok": True}


def prepare(request):
    min_side, max_side = request["min_side"], request["max_side"]
    with Image.open(request["source"]) as source:
        ratio = source.width / request["layout"][0]
        x, y, w, h = (value * ratio for value in request["crop"])
        picture = source.crop((round(x), round(y), round(x + w), round(y + h))).convert("RGB")
    upscale_to = request.get("upscale_to")
    if upscale_to and max(picture.size) < upscale_to:
        scale = upscale_to / max(picture.size)
        picture = picture.resize((round(picture.width * scale), round(picture.height * scale)), Image.LANCZOS)
    picture.thumbnail((max_side, max_side), Image.LANCZOS)
    frame = [0.0, 0.0, 1.0, 1.0]
    if min(picture.size) < min_side:
        canvas = Image.new("RGB", (max(picture.width, min_side), max(picture.height, min_side)), "white")
        left, top = (canvas.width - picture.width) // 2, (canvas.height - picture.height) // 2
        canvas.paste(picture, (left, top))
        frame = [left / canvas.width, top / canvas.height, picture.width / canvas.width, picture.height / canvas.height]
        picture = canvas
    picture.save(request["out"], "JPEG", quality=90)
    return {"frame": frame}


def main():
    command = sys.argv[1]
    request = json.loads(sys.stdin.read())
    print(json.dumps({"annotate": annotate, "prepare": prepare}[command](request)))


if __name__ == "__main__":
    main()
