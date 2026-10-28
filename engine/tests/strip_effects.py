"""RFC-020's executor against the effects ported to Vulkan after the first port.

`strip_executor.py` pins the executor at the shipped settings, where neither
scene latitude mapping nor the contrast mask runs. Both read the frame's own
coordinates inside a band -- the latitude's pair split along the long edge,
the mask's grid at `row0 + i / W` -- so a band that read them at its own rows
would still render, and render wrongly. This renders each effect whole and in
strips of several heights and requires the bytes to agree.

    SPEKTRAFILM_ENGINE_LIBRARY=<engine dll or dylib> python3 strip_effects.py
"""
import argparse
import hashlib
import sys
from pathlib import Path

import numpy as np

import spk_ctypes


def frame(h: int, w: int) -> np.ndarray:
    # ~10 stops left to right, a vertical colour drift, and a bright disc, so
    # both of the latitude's sides, the mask's highlight and shadow branches
    # and a portrait split all have something to act on.
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    level = 0.184 * np.exp2(x / w * 10.0 - 6.0)
    img = np.stack([level * (1.0 + 0.2 * y / h), level, level * (1.2 - 0.3 * y / h)], axis=-1)
    disc = (x - 0.7 * w) ** 2 + (y - 0.4 * h) ** 2 < (0.15 * h) ** 2
    img[disc] *= 8.0
    return np.ascontiguousarray(img, dtype=np.float32)


EFFECTS = {
    "scene latitude": {"scene_latitude_active": True, "scene_latitude_highlight_knee": 0.5,
                       "scene_latitude_highlight_room": 2.0, "scene_latitude_shadow_knee": -1.0,
                       "scene_latitude_shadow_room": 2.0},
    "scene latitude, pair split": {"scene_latitude_active": True, "scene_latitude_highlight_knee": 0.5,
                                   "scene_latitude_highlight_room": 2.0, "scene_latitude_split": 0.5,
                                   "scene_latitude_b_active": True, "scene_latitude_b_shadow_knee": -0.5,
                                   "scene_latitude_b_shadow_room": 3.0},
    "contrast mask": {"contrast_mask_active": True, "contrast_mask_highlights": 2.0,
                      "contrast_mask_shadows": 1.5},
    "latitude + mask": {"scene_latitude_active": True, "scene_latitude_highlight_knee": 0.5,
                        "scene_latitude_highlight_room": 2.0, "contrast_mask_active": True,
                        "contrast_mask_highlights": 2.0},
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dylib", type=Path, default=None)
    args = parser.parse_args()
    failures = 0
    with spk_ctypes.Engine(dylib=args.dylib) as engine:
        print(f"build:  {engine.build_info}")
        for orientation, (h, w) in (("landscape", (240, 340)), ("portrait", (340, 240))):
            img = frame(h, w)
            for name, delta in EFFECTS.items():
                digests = {}
                plain = None
                for rows in (h, 100, 37, 7):
                    params = {"product_defaults": True, "striped": True, "strip_rows": rows, **delta}
                    with engine.open(img, params) as session:
                        full, _ = session.render("full")
                        again, _ = session.render("full", reprint=True)
                    digests[rows] = (hashlib.sha1(full.tobytes()).hexdigest()[:16],
                                     hashlib.sha1(again.tobytes()).hexdigest()[:16])
                with engine.open(img, {"product_defaults": True}) as session:
                    plain, _ = session.render("full")
                whole = digests[h]
                same = all(d == whole for d in digests.values())
                moved = not np.array_equal(full, plain)
                ok = same and moved
                failures += not ok
                detail = (f"render {whole[0]}, reprint {whole[1]} at every strip height"
                          if same else f"{digests}")
                if not moved:
                    detail += "; and the effect left the picture unchanged"
                print(f"{'ok  ' if ok else 'FAIL'}  {orientation} {name}: {detail}")
    print(f"\n{failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
