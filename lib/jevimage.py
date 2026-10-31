import json
import sys

from PIL import Image

MIN_SIDE, MAX_SIDE = 280, 1568


def prepare(source, crop, upscale_to, out):
    if crop:
        x, y, w, h = crop
        picture = source.crop((round(x), round(y), round(x + w), round(y + h)))
    else:
        picture = source.copy()
    picture = picture.convert("RGB")
    if upscale_to and max(picture.size) < upscale_to:
        scale = upscale_to / max(picture.size)
        picture = picture.resize((round(picture.width * scale), round(picture.height * scale)), Image.LANCZOS)
    picture.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    frame = [0.0, 0.0, 1.0, 1.0]
    if min(picture.size) < MIN_SIDE:
        canvas = Image.new("RGB", (max(picture.width, MIN_SIDE), max(picture.height, MIN_SIDE)), "white")
        x, y = (canvas.width - picture.width) // 2, (canvas.height - picture.height) // 2
        canvas.paste(picture, (x, y))
        frame = [x / canvas.width, y / canvas.height, picture.width / canvas.width, picture.height / canvas.height]
        picture = canvas
    picture.save(out, "JPEG", quality=90)
    return {"file": out, "frame": frame}


def main():
    request = json.loads(sys.argv[1])
    with Image.open(request["source"]) as source:
        results = [prepare(source, item.get("crop"), item.get("upscale_to"), item["out"]) for item in request["images"]]
    print(json.dumps(results))


main()
