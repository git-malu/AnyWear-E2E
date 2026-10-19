"""Build frozen, valid sizing image bytes with Pillow; never calls a provider.

Every emitted fixture is inside its reviewed bound: the demonstrated S1 input bound
(``S1_INPUT_BYTES_MAX``) for ordinary fixtures, and the widening-candidate bound for
the one preserved exact fixture that fixture is measured at. The builder never
raises the demonstrated bound to accommodate a fixture: a fixture whose bytes
exceed the demonstrated bound is losslessly transcoded, and if even its normally
compressed bytes exceed the bound its pixels are reduced.

The two PNG variants are PRESERVED, never rebuilt: the exact fixture is restored
byte-for-byte from repository history and the garment variant is its reviewed
re-encode. The builder copies both through after checking their size, SHA-256 and
dimensions against their accepted manifest entries, so re-running it cannot
re-encode either one into the other.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path

from PIL import Image, ImageOps, __version__ as pillow_version

S1_INPUT_BYTES_MAX = 697_437
PNG_COMPRESS_LEVEL = 9
WEBP_OPTIONS = {"lossless": True, "method": 4}
JPEG_ENVELOPE_OPTIONS = {"quality": 100, "subsampling": 2}

SOURCES = {"base-photo": "photo-1515886657613-9f3515b0c78f", "trousers": "photo-1542272604-787c3835535d",
           "shoes": "photo-1542291026-7eec264c27ff", "bag": "photo-1553062407-98eeb64c6a62",
           "jacket": "photo-1551028719-00167b16eac5"}
SWEATER_FORMATS = ["jpg", "png", "webp"]
FORMATS = {"jpg": "JPEG", "png": "PNG", "webp": "WEBP"}

# Mirrors `S1_WIDENING_CANDIDATE` / `S1_GARMENT_PNG_FIXTURE` in
# beta-sizing-envelope.mjs. The widening candidate is a separate record and never
# raises the demonstrated bound; only the two candidate case IDs may submit the
# exact fixture, and that only in the measure/S1 widening-candidate mode.
S1_WIDENING_CANDIDATE = {
    "bound_bytes": 3_742_711,
    "fixture": "sweater-ordinary.png",
    "case_ids": ["burst-ordinary-png-0", "burst-ordinary-png-1"],
    "prior_bound_bytes": S1_INPUT_BYTES_MAX,
    "authorising_issue": 140,
    "status": "candidate",
}
S1_GARMENT_PNG = "sweater-ordinary-garment.png"

# The PNG fixtures this builder must never rebuild. `sweater-ordinary.png` is the
# restored exact failed input and the widening candidate; `sweater-ordinary-garment.png`
# is its reviewed 696,168-byte garment-size re-encode. Each allowed byte ceiling is
# explicit so the exact fixture is accepted only at the candidate bound.
PRESERVED_PNG_FIXTURES = {
    "sweater-ordinary.png": S1_WIDENING_CANDIDATE["bound_bytes"],
    S1_GARMENT_PNG: S1_INPUT_BYTES_MAX,
}

# Mirrors `S1_DIAGNOSTIC_PROBE` and the manifest's `diagnostic` record. The truncated
# PNG is a non-qualifying probe: valid signature, invalid body, expected to settle
# `input_image_decode_failed` in one execution with zero provider calls.
S1_DIAGNOSTIC_PROBE = {
    "case_id": "diagnostic-truncated-png-0",
    "id": "diagnostic-truncated.png",
    "file": "diagnostic/truncated.png",
    "mime": "image/png",
    "bytes": 400,
    "sha256": "a0887534883a0b0c35bad438be7fe3c4aa2c6b48ef893c7eacec1a66276a3063",
    "expected_failure_code": "input_image_decode_failed",
    "qualifying": False,
    "source": "first 400 bytes of sweater-ordinary.png",
    "source_sha256": "4341430c05ebcc7af7385fce5025c8930b8def0fb5c13f9b4c0f1014bcd3f130",
    "derivation": ("valid 8-byte PNG signature and complete IHDR; the IDAT body is truncated "
                   "before IEND, so a decoder must reject it"),
}

# Mirrors `S1_INPUT_ENVELOPE` in beta-sizing-envelope.mjs. The loader refuses a
# manifest whose declared envelope disagrees with those constants, so this block
# and the module must change together.
SIZING_VTO_AGGREGATE_LIMIT = ("per submitted input, not per aggregate: the VTO aggregate (base photo "
                              "plus garments) is a separate, unproven quantity recorded as "
                              "aggregate_submitted_bytes per observation")

S1_VTO_SHAPE_NAMING = ("the `large-base-*` shape identifiers are historical names retained for binding "
                       "stability, not a description of the fixture: every submitted shape uses "
                       "base-photo-ordinary.jpg, and the only shape that carried the large base photo is "
                       "the deferred five-garment one")

S1_DEFERRED_VTO_SHAPE = {
    "shape": "representative-larger-outfit-output",
    "garment_count": 5,
    "advanced_settings": {"size": "4K"},
    "garment_fixtures": ["bag-ordinary.jpg", "shoes-ordinary.jpg", "trousers-ordinary.jpg",
                         "jacket-ordinary.jpg", S1_GARMENT_PNG],
    "garment_only_bytes": 2408024,
    "base_photo_bytes": 545720,
    "aggregate_submitted_bytes": 2953744,
    # The deferred shape is a VTO payload defect (#172), not the tagging envelope.
    "reason": "deferred_to_172_vto_base64_payload",
}

S1_INPUT_ENVELOPE = {
    "reference": "beta-qualification-diagnostics-38768690421-1",
    "run_url": "https://github.com/git-malu/AnyWear-E2E/actions/runs/38768690421",
    "run_id": 38768690421,
    "run_attempt": 1,
    "stage": "S1",
    "e2e_sha": "2fb06bce239e483eae77f7095062dc06fc395891",
    "workload": "test-results/beta-sizing-workload.json",
    "input_bytes_max": S1_INPUT_BYTES_MAX,
    "input_bytes_max_basis": "per submitted input; a VTO aggregate is a separate quantity and is not proven by it",
    "measured_inputs_basis": ("historical run evidence from run 38768690421; the restored sweater-ordinary.png "
                              "is that run's exact bytes, while the other shipped fixtures are re-encoded and "
                              "are not these byte counts"),
    "measured_inputs": [
        {"case_id": "sequential-ordinary-jpg-0", "fixture": "trousers-ordinary.jpg",
         "bytes": 441913, "width": 1200, "height": 960, "terminal_state": "ready", "seconds": 25.7},
        {"case_id": "sequential-ordinary-jpg-1", "fixture": "jacket-ordinary.jpg",
         "bytes": 697437, "width": 900, "height": 1200, "terminal_state": "ready", "seconds": 85.0},
        {"case_id": "sequential-ordinary-png-0", "fixture": "sweater-ordinary.png",
         "bytes": 3742711, "width": 1200, "height": 1039, "terminal_state": "failed"},
    ],
    "largest_served_bytes": 697437,
    "largest_served_case_id": "sequential-ordinary-jpg-1",
    "excluded_fixtures": [
        {"id": "base-photo-large.jpg", "bytes": 2611145, "width": 2124, "height": 2940,
         "sha256": "a7b6638f370cf06800211280934da7ccf00d04eac7fb86654fe54b5784c96b46",
         "size_class": "large-base", "reason": "not_in_reviewed_case_matrix"},
        {"id": "sweater-large.jpg", "bytes": 9218003, "width": 6357, "height": 5505,
         "sha256": "9e1cde764270b3b10cbbaf0fee21c2b260d438fc67d256f42c9ca5a52680b02b",
         "size_class": "near-supported-limit", "reason": "input_bytes_above_envelope"},
        {"id": "sweater-large.png", "bytes": 9749963, "width": 1937, "height": 1677,
         "sha256": "f2403c1c0134179aedb0fbdc7cc6ed4ad7834fa2f838cf5450cf8889a6b7d36d",
         "size_class": "near-supported-limit", "reason": "input_bytes_above_envelope"},
        {"id": "sweater-large.webp", "bytes": 9748684, "width": 3952, "height": 5269,
         "sha256": "5cbef6e1b51f33ff99e24cec94a6742f4af216402eccb76dba203f18bbae2386",
         "size_class": "near-supported-limit", "reason": "input_bytes_above_envelope"},
    ],
    "excluded_reason": ("deferred to the #140 large-input defect: no case may submit an input above the largest "
                        "input this deployment is demonstrated to serve"),
    "widening_candidate": S1_WIDENING_CANDIDATE,
    "vto_aggregate_limit": SIZING_VTO_AGGREGATE_LIMIT,
    "vto_shape_naming": S1_VTO_SHAPE_NAMING,
    "deferred_vto_shape": S1_DEFERRED_VTO_SHAPE,
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encode(image, fmt):
    options = {"JPEG": JPEG_ENVELOPE_OPTIONS, "PNG": {"compress_level": PNG_COMPRESS_LEVEL},
               "WEBP": WEBP_OPTIONS}
    output = io.BytesIO()
    image.save(output, fmt, **options[fmt])
    return output.getvalue()


def reviewed_encoding(ext):
    return {"jpg": {"codec": "jpeg", **JPEG_ENVELOPE_OPTIONS},
            "png": {"codec": "png", "compress_level": PNG_COMPRESS_LEVEL},
            "webp": {"codec": "webp", **WEBP_OPTIONS}}[ext]


def mime_of(ext):
    return {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}[ext]


def shrink_to_bound(image, fmt, label):
    """Largest lossless re-encode of image whose bytes fit the bound."""
    low, high, best = 1, image.width, None
    while low <= high:
        width = (low + high) // 2
        scaled = image.resize((width, round(width * image.height / image.width)), Image.Resampling.LANCZOS)
        data = encode(scaled, fmt)
        if len(data) <= S1_INPUT_BYTES_MAX:
            best = (scaled, data)
            low = width + 1
        else:
            high = width - 1
    if best is None:
        raise ValueError(f"{label} cannot fit {S1_INPUT_BYTES_MAX} B at any width")
    return best


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inputs", type=Path, required=True,
                        help="directory holding the accepted fixture bytes")
    parser.add_argument("--manifest", type=Path, default=None,
                        help="accepted manifest supplying provenance; defaults to <inputs>/fixture-manifest.json")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest_path = args.manifest or (args.inputs / "fixture-manifest.json")
    accepted = {item["id"]: item for item in json.loads(manifest_path.read_text(encoding="utf-8"))["fixtures"]}
    args.output.mkdir(parents=True, exist_ok=True)
    fixtures = []

    def emit(name, image, data, ext, size_class, provenance, derivation,
             max_bytes=S1_INPUT_BYTES_MAX, encoding=None):
        if not isinstance(data, (bytes, bytearray)) or not data:
            raise ValueError(f"{name} has no encoded bytes")
        if len(data) > max_bytes:
            raise ValueError(f"{name} is {len(data)} B, above its reviewed input bound of {max_bytes} B")
        if not provenance.get("source") or not provenance.get("source_sha256"):
            raise ValueError(f"{name} needs declared source provenance")
        (args.output / name).write_bytes(data)
        fixtures.append({"id": name, "file": name, "mime": mime_of(ext), "size_class": size_class,
                         "bytes": len(data), "width": image.width, "height": image.height,
                         "sha256": digest(data), "source": provenance["source"],
                         "source_sha256": provenance["source_sha256"],
                         "encoding": encoding or reviewed_encoding(ext),
                         "s1_bytes": len(data), "derivation": derivation})

    def preserve_png(name, max_bytes):
        """Copy a preserved PNG through byte-for-byte; never re-encode it."""
        prior = accepted.get(name)
        if not prior:
            raise ValueError(f"{name} needs an accepted manifest entry to preserve it byte-for-byte")
        data = (args.inputs / name).read_bytes()
        if len(data) != prior["bytes"] or digest(data) != prior["sha256"]:
            raise ValueError(f"{name} bytes do not match its accepted manifest entry; refusing to re-encode")
        if len(data) > max_bytes:
            raise ValueError(f"{name} is {len(data)} B, above its reviewed input bound of {max_bytes} B")
        image = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
        if (image.width, image.height) != (prior["width"], prior["height"]):
            raise ValueError(f"{name} dimensions changed from its accepted manifest entry")
        return emit(name, image, data, "png", prior.get("size_class", "ordinary"),
                    {"source": prior["source"], "source_sha256": prior["source_sha256"]},
                    prior.get("derivation") or "accepted fixture retained byte-for-byte",
                    max_bytes=max_bytes, encoding=prior.get("encoding"))

    def preserve_diagnostic():
        """Copy the truncated PNG probe through and record its exact bytes."""
        source = (args.inputs / S1_DIAGNOSTIC_PROBE["file"]).read_bytes()
        if len(source) != S1_DIAGNOSTIC_PROBE["bytes"] or digest(source) != S1_DIAGNOSTIC_PROBE["sha256"]:
            raise ValueError("diagnostic probe bytes changed")
        if not source.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("diagnostic probe must carry a valid PNG signature")
        if b"IEND" in source:
            raise ValueError("diagnostic probe must be truncated before IEND")
        (args.output / "diagnostic").mkdir(parents=True, exist_ok=True)
        (args.output / S1_DIAGNOSTIC_PROBE["file"]).write_bytes(source)
        return dict(S1_DIAGNOSTIC_PROBE)

    def build(name, ext, size_class, fallback_source):
        fmt = FORMATS[ext]
        prior = accepted.get(name)
        source_bytes = (args.inputs / name).read_bytes()
        provenance = {"source": prior.get("source") if prior else fallback_source,
                      "source_sha256": prior.get("source_sha256") if prior else None}
        if not provenance.get("source_sha256"):
            raise ValueError(f"{name} has no accepted source provenance; refusing to invent one")
        image = ImageOps.exif_transpose(Image.open(io.BytesIO(source_bytes))).convert("RGB")
        at_reviewed_encoding = bool(prior) and prior.get("encoding") == reviewed_encoding(ext)
        if len(source_bytes) <= S1_INPUT_BYTES_MAX and at_reviewed_encoding:
            return emit(name, image, source_bytes, ext, size_class, provenance,
                        "accepted fixture retained byte-for-byte at the reviewed envelope encoding")
        encoded = encode(image, fmt)
        if len(encoded) <= S1_INPUT_BYTES_MAX:
            # The encoding is the claim that has to be exact: a fixture re-encoded
            # from the legacy 4:4:4 settings keeps its dimensions but not its chroma.
            if fmt == "JPEG":
                derivation = ("re-encoded at the reviewed envelope encoding (quality 100, 4:2:0 subsampling); "
                              "same %dx%d pixels, chroma resampled from the legacy 4:4:4 source" % (image.width, image.height))
            else:
                derivation = "re-encoded at the reviewed lossless envelope encoding; no pixel changed"
            if len(encoded) != len(source_bytes):
                derivation += f"; {len(source_bytes)} B -> {len(encoded)} B"
            return emit(name, image, encoded, ext, size_class, provenance,
                        f"{derivation} (source bytes {digest(source_bytes)[:16]})")
        if fmt == "JPEG":
            raise ValueError(f"{name} has no lossless fallback; it must be rebuilt from original source pixels")
        image, data = shrink_to_bound(image, fmt, name)
        # Same pixels, normally compressed: this is the size that had to be reduced.
        compressed = len(encode(Image.open(io.BytesIO(source_bytes)).convert("RGB"), fmt))
        return emit(name, image, data, ext, size_class, provenance,
                    f"lossless {fmt} transcode of an over-bound fixture; "
                    f"{len(source_bytes)} B exceeded the bound and the normally compressed form of the same "
                    f"pixels is {compressed} B, so the pixels are reduced: "
                    f"{image.width}x{image.height} from {prior['width']}x{prior['height']}, "
                    f"aspect retained, Lanczos resample, no lossy codec")

    # The two PNG variants are preserved, never rebuilt: the exact fixture at its
    # candidate bound and the garment variant at the demonstrated bound.
    for name, max_bytes in PRESERVED_PNG_FIXTURES.items():
        preserve_png(name, max_bytes)
    for ext in [value for value in SWEATER_FORMATS if value != "png"]:
        build("sweater-ordinary." + ext, ext, "ordinary", fallback_source="../dummy.png")
    for component in SOURCES:
        build(component + "-ordinary.jpg", "jpg", "ordinary", fallback_source="https://images.unsplash.com/" + SOURCES[component])
    diagnostic = preserve_diagnostic()

    manifest = {"schema_version": 1, "builder": "Pillow " + pillow_version,
                "license": "Public Unsplash images: https://unsplash.com/license; existing dummy.png retains repository provenance",
                "transform": "EXIF transpose, RGB, Lanczos resize, valid codec; no padding or added noise",
                "s1_input_envelope": S1_INPUT_ENVELOPE,
                "fixtures": fixtures,
                "diagnostic": diagnostic}
    (args.output / "fixture-manifest.json").write_bytes(
        (json.dumps(manifest, indent=2) + "\n").encode("utf-8"))
    for item in fixtures:
        print(f"{item['id']:<26} {item['bytes']:>9} B  {item['width']}x{item['height']}  {item['sha256'][:16]}")
    print(f"{diagnostic['id']:<26} {diagnostic['bytes']:>9} B  diagnostic probe  {diagnostic['sha256'][:16]}")


if __name__ == "__main__":
    main()
