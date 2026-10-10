"""Build frozen, valid sizing image bytes with Pillow; never calls a provider."""
import argparse
import hashlib
import io
import json
from pathlib import Path

from PIL import Image, ImageOps, __version__ as pillow_version


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(image, fmt):
    output = io.BytesIO()
    options = {"JPEG": {"quality": 100, "subsampling": 0},
               "PNG": {"compress_level": 0}, "WEBP": {"lossless": True, "method": 4}}
    image.save(output, fmt, **options[fmt])
    return output.getvalue()


def near_limit(image, fmt):
    low, high = 1200, int((35_000_000 / (image.height / image.width)) ** 0.5)
    best = None
    for _ in range(15):
        width = (low + high) // 2
        scaled = image.resize((width, round(width * image.height / image.width)), Image.Resampling.LANCZOS)
        data = encoded(scaled, fmt)
        if len(data) <= 9_750_000:
            best = (scaled, data)
            low = width + 1
        else:
            high = width - 1
        if low > high:
            break
    if best is None or len(best[1]) < 9_000_000:
        raise ValueError("Cannot build a valid near-limit fixture without exceeding the pixel envelope")
    return best


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--sweater", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    fixtures = []

    def save(name, image, data, mime, size_class, source, source_hash):
        (args.output / name).write_bytes(data)
        fixtures.append({"id": name, "file": name, "mime": mime, "size_class": size_class,
                         "bytes": len(data), "width": image.width, "height": image.height,
                         "sha256": digest(data), "source": source, "source_sha256": source_hash})

    sweater_bytes = args.sweater.read_bytes()
    sweater = ImageOps.exif_transpose(Image.open(io.BytesIO(sweater_bytes))).convert("RGB")
    for fmt, ext in [("JPEG", "jpg"), ("PNG", "png"), ("WEBP", "webp")]:
        mime = "image/" + ("jpeg" if fmt == "JPEG" else fmt.lower())
        ordinary = ImageOps.contain(sweater, (1200, 1200))
        save("sweater-ordinary." + ext, ordinary, encoded(ordinary, fmt), mime, "ordinary",
             "../dummy.png", digest(sweater_bytes))
        large_source_bytes = (args.inputs / 'issue95-jacket-detail.jpg').read_bytes() if fmt == 'WEBP' else sweater_bytes
        large_source = ImageOps.exif_transpose(Image.open(io.BytesIO(large_source_bytes))).convert('RGB')
        image, data = near_limit(large_source, fmt)
        save("sweater-large." + ext, image, data, mime, "near-supported-limit",
             "https://images.unsplash.com/photo-1551028719-00167b16eac5" if fmt == 'WEBP' else "../dummy.png", digest(large_source_bytes))

    sources = {"base-photo": "photo-1515886657613-9f3515b0c78f", "trousers": "photo-1542272604-787c3835535d",
               "shoes": "photo-1542291026-7eec264c27ff", "bag": "photo-1553062407-98eeb64c6a62",
               "jacket": "photo-1551028719-00167b16eac5"}
    for name, photo in sources.items():
        data = (args.inputs / ("issue95-" + name + ".jpg")).read_bytes()
        image = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
        source = "https://images.unsplash.com/" + photo
        ordinary = ImageOps.contain(image, (1200, 1200))
        save(name + "-ordinary.jpg", ordinary, encoded(ordinary, "JPEG"), "image/jpeg", "ordinary", source, digest(data))
        if name == "base-photo":
            save("base-photo-large.jpg", image, encoded(image, "JPEG"), "image/jpeg", "large-base", source, digest(data))

    manifest = {"schema_version": 1, "builder": "Pillow " + pillow_version,
                "license": "Public Unsplash images: https://unsplash.com/license; existing dummy.png retains repository provenance",
                "transform": "EXIF transpose, RGB, Lanczos resize, valid codec; no padding or added noise",
                "fixtures": fixtures}
    (args.output / "fixture-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
