// pair.hpp -- a half-frame pair as one decode (the Mac's PairComposer.swift,
// HalfFramePair.swift).
//
// Two frames laid on one frame's worth of 135: each picture under its own
// 18 x 24 mm hole, the gap between them black (no light reached it). The
// result is an ordinary linear ProPhoto frame, so the engine, the canvas and
// the export take a pair as they take any frame. The layout and the placement
// arithmetic are the Mac's, line for line, so a `.spektrapair` composes the
// same piece on either platform.
#pragma once
#include <cstdint>

#include "image_io.hpp"

namespace spkhost {

// Where the picture sits under its hole. The hole never moves; the picture
// does. `scale` 1 fills the hole and never goes below that.
struct PairPlacement {
    double scale = 1.0;      // 1..4
    double x = 0.0, y = 0.0; // -1..1 across the slack left by the fit
    int quarter_turns = 0;   // clockwise
};

// The piece in pixels: two holes, the second `advance` along the film --
// across the piece held level, down it when turned.
struct PairLayout {
    uint32_t hole_w = 0, hole_h = 0, advance = 0;
    bool turned = false;
    uint32_t width() const { return turned ? hole_w : advance + hole_w; }
    uint32_t height() const { return turned ? advance + hole_h : hole_h; }
    // Top-left origin; side 0 is the left hole, or the upper one when turned.
    uint32_t x(int side) const { return turned ? 0 : (side ? advance : 0); }
    uint32_t y(int side) const { return turned ? (side ? advance : 0) : 0; }
};

constexpr double kHoleAlongMM = 18.0, kHoleAcrossMM = 24.0;

// HalfFramePair.layout(holeHeight:spacingMM:turned:).
PairLayout pair_layout(int across, double spacing_mm, bool turned);

// The hole's shape, width over height.
inline double hole_aspect(bool turned) {
    return turned ? kHoleAcrossMM / kHoleAlongMM : kHoleAlongMM / kHoleAcrossMM;
}

// PairComposer.layout(for:sizes:): holes as large as the smaller picture is
// across its hole, and the piece never longer than the longer picture.
// `w`/`h` are the decoded pictures (0 x 0 for an empty hole).
PairLayout pair_layout_for(const uint32_t w[2], const uint32_t h[2], const PairPlacement place[2],
                           double spacing_mm, bool turned);

// `src` turned, cut to the placement's rectangle and scaled into the hole,
// times `gain`, written into `piece` (already sized and black). Bilinear,
// edges extended (Core Image's clampedToExtent).
void place_into(const FloatImage& src, const PairPlacement& place, double gain, const PairLayout& layout,
                int side, FloatImage& piece);

// The hole's own picture at hole size (the same cut and scale), for metering
// that frame by itself.
FloatImage hole_picture(const FloatImage& src, const PairPlacement& place, const PairLayout& layout);

}  // namespace spkhost
