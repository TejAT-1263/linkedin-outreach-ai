import sys
from PIL import Image, ImageDraw
out = sys.argv[1]
S = 512
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, S-1, S-1], radius=110, fill=(26, 86, 219, 255))
# speech bubble
d.rounded_rectangle([96, 120, 416, 340], radius=60, fill=(255, 255, 255, 255))
d.polygon([(170, 330), (150, 420), (250, 335)], fill=(255, 255, 255, 255))
# three text lines
for i, w in enumerate([220, 180, 120]):
    y = 175 + i * 52
    d.rounded_rectangle([146, y, 146 + w, y + 24], radius=12, fill=(26, 86, 219, 255))
for size in (16, 48, 128):
    img.resize((size, size), Image.LANCZOS).save(f"{out}/icon{size}.png")
