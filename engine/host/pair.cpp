// pair.cpp -- see pair.hpp.
#include "pair.hpp"

#include <algorithm>
#include <cmath>
#include <thread>
#include <vector>

namespace spkhost {

PairLayout pair_layout(int across, double spacing_mm, bool turned) {
    const int a = std::max(across, 8);
    const int along = std::max(int(std::lround(double(a) * kHoleAlongMM / kHoleAcrossMM)), 6);
    const int advance = int(std::lround(double(along) * (kHoleAlongMM + spacing_mm) / kHoleAlongMM));
    PairLayout l;
    l.turned = turned;
    l.hole_w = uint32_t(turned ? a : along);
    l.hole_h = uint32_t(turned ? along : a);
    l.advance = uint32_t(advance);
    return l;
}

namespace {

struct Rect { double x, y, w, h; };

// HalfFramePair.sourceRect(for:source:aspect:), y down.
Rect source_rect(const PairPlacement& p, double sw, double sh, double aspect) {
    if (!(sw > 0) || !(sh > 0)) return {0, 0, 0, 0};
    double w = sw, h = sh;
    if (w / h > aspect) w = h * aspect;
    else h = w / aspect;
    const double s = std::clamp(p.scale, 1.0, 4.0);
    w /= s;
    h /= s;
    const double cx = sw / 2 + std::clamp(p.x, -1.0, 1.0) * (sw - w) / 2;
    const double cy = sh / 2 + std::clamp(p.y, -1.0, 1.0) * (sh - h) / 2;
    return {cx - w / 2, cy - h / 2, w, h};
}

int turns_of(const PairPlacement& p) { return ((p.quarter_turns % 4) + 4) % 4; }

// A point of the picture as seen after `turns` clockwise quarter turns, back
// in the source's own pixels (both y down).
void unturn(int turns, double u, double v, uint32_t sw, uint32_t sh, double& x, double& y) {
    switch (turns) {
    case 1: x = v; y = double(sh) - u; break;                 // seen (u, v) after one cw turn
    case 2: x = double(sw) - u; y = double(sh) - v; break;
    case 3: x = double(sw) - v; y = u; break;
    default: x = u; y = v; break;
    }
}

void sample(const FloatImage& src, double x, double y, float out[3]) {
    // Pixel centres at +0.5; edges extended.
    const double fx = std::clamp(x - 0.5, 0.0, double(src.width) - 1.0);
    const double fy = std::clamp(y - 0.5, 0.0, double(src.height) - 1.0);
    const uint32_t x0 = uint32_t(fx), y0 = uint32_t(fy);
    const uint32_t x1 = std::min(x0 + 1, src.width - 1), y1 = std::min(y0 + 1, src.height - 1);
    const double ax = fx - x0, ay = fy - y0;
    const float* p00 = &src.rgb[(size_t(y0) * src.width + x0) * 3];
    const float* p01 = &src.rgb[(size_t(y0) * src.width + x1) * 3];
    const float* p10 = &src.rgb[(size_t(y1) * src.width + x0) * 3];
    const float* p11 = &src.rgb[(size_t(y1) * src.width + x1) * 3];
    for (int c = 0; c < 3; ++c) {
        const double top = p00[c] + (p01[c] - p00[c]) * ax;
        const double bottom = p10[c] + (p11[c] - p10[c]) * ax;
        out[c] = float(top + (bottom - top) * ay);
    }
}

template <class F>
void rows(uint32_t n, F&& fn) {
    const uint32_t workers = std::max(1u, std::min(n, std::thread::hardware_concurrency()));
    std::vector<std::thread> pool;
    for (uint32_t t = 1; t < workers; ++t)
        pool.emplace_back([&, t] { for (uint32_t r = t; r < n; r += workers) fn(r); });
    for (uint32_t r = 0; r < n; r += workers) fn(r);
    for (auto& th : pool) th.join();
}

// Fill a hole-sized window of `dst` (at ox, oy) with the placed picture.
void place_at(const FloatImage& src, const PairPlacement& place, double gain, const PairLayout& layout,
              FloatImage& dst, uint32_t ox, uint32_t oy) {
    if (!src.width || !src.height) return;
    const int turns = turns_of(place);
    const double tw = turns % 2 ? src.height : src.width, th = turns % 2 ? src.width : src.height;
    const Rect cut = source_rect(place, tw, th, hole_aspect(layout.turned));
    if (!(cut.h > 0)) return;
    const double scale = double(layout.hole_h) / cut.h;
    rows(layout.hole_h, [&](uint32_t hy) {
        for (uint32_t hx = 0; hx < layout.hole_w; ++hx) {
            const double u = cut.x + (hx + 0.5) / scale, v = cut.y + (hy + 0.5) / scale;
            double sx, sy;
            unturn(turns, u, v, src.width, src.height, sx, sy);
            float px[3];
            sample(src, sx, sy, px);
            float* o = &dst.rgb[(size_t(oy + hy) * dst.width + (ox + hx)) * 3];
            for (int c = 0; c < 3; ++c) o[c] = float(px[c] * gain);
        }
    });
}

}  // namespace

PairLayout pair_layout_for(const uint32_t w[2], const uint32_t h[2], const PairPlacement place[2],
                           double spacing_mm, bool turned) {
    double across = 0.0, longest = 0.0;
    bool any = false;
    for (int side = 0; side < 2; ++side) {
        if (!w[side] || !h[side]) continue;
        // At the picture's own fit, whatever it is zoomed to: a zoom must not
        // resize the piece.
        const int turns = turns_of(place[side]);
        const double tw = turns % 2 ? h[side] : w[side], th = turns % 2 ? w[side] : h[side];
        PairPlacement fit = place[side];
        fit.scale = 1.0;
        const Rect cut = source_rect(fit, tw, th, hole_aspect(turned));
        const double a = turned ? cut.w : cut.h;
        across = any ? std::min(across, a) : a;
        any = true;
        longest = std::max(longest, std::max(double(w[side]), double(h[side])));
    }
    double a = any ? across : 2400.0;
    if (longest > 0) {
        // At the camera's own 1 mm, whatever the spacing: a hole's size must
        // not move with the gap.
        const double piece_long = (kHoleAlongMM * 2 + 1) / kHoleAcrossMM;
        a = std::min(a, longest / piece_long);
    }
    return pair_layout(int(std::floor(a)), spacing_mm, turned);
}

void place_into(const FloatImage& src, const PairPlacement& place, double gain, const PairLayout& layout,
                int side, FloatImage& piece) {
    place_at(src, place, gain, layout, piece, layout.x(side), layout.y(side));
}

FloatImage hole_picture(const FloatImage& src, const PairPlacement& place, const PairLayout& layout) {
    FloatImage out;
    out.width = layout.hole_w;
    out.height = layout.hole_h;
    out.rgb.assign(size_t(out.width) * out.height * 3, 0.0f);
    place_at(src, place, 1.0, layout, out, 0, 0);
    return out;
}

}  // namespace spkhost
