// edge_raster.cpp -- see edge_raster.hpp. Not compiled on Apple, where
// overscan.cpp keeps CoreGraphics, CoreText and vImage.
#ifndef __APPLE__
#include "edge_raster.hpp"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <map>
#include <memory>
#include <mutex>
#include <thread>

#define STB_TRUETYPE_IMPLEMENTATION
#define STBTT_STATIC
#include "../../third_party/stb/stb_truetype.h"

namespace spk::edge {

Affine Affine::rotate(double r) {
    const double c = std::cos(r), s = std::sin(r);
    return {c, s, -s, c, 0, 0};
}

// ---------------------------------------------------------------------------
// Coverage. Each fill deposits the signed area every edge covers in each
// cell of a row (the accumulation rasteriser of font-rs / libart), then a
// running sum along the row is the winding-weighted coverage: exact for
// straight edges, with no sub-sampling grid. |sum| clamped to 1 is the
// non-zero rule for the overlaps a glyph or a mark ever has.
// ---------------------------------------------------------------------------

Canvas::Canvas(int w, int h)
    : w_(std::max(w, 0)), h_(std::max(h, 0)), grey_(size_t(w_) * size_t(h_), 0.0f),
      acc_(size_t(w_ + 2) * size_t(h_), 0.0f) {}

void Canvas::line(Point p0, Point p1) {
    if (p0.y == p1.y) return;
    double dir = 1.0;
    if (p0.y > p1.y) { std::swap(p0, p1); dir = -1.0; }
    if (p1.y <= 0.0 || p0.y >= h_) return;
    const double dxdy = (p1.x - p0.x) / (p1.y - p0.y);
    const size_t stride = size_t(w_) + 2;
    // Left of the bitmap, coverage only depends on the crossing: clamp x to
    // [0, w] so it lands in column 0 or the spare columns at the right.
    auto clampx = [&](double x) { return std::clamp(x, 0.0, double(w_)); };
    const int ystart = std::max(0, int(std::floor(p0.y)));
    const int yend = std::min(h_, int(std::ceil(p1.y)));
    for (int y = ystart; y < yend; ++y) {
        const double ya = std::max(double(y), p0.y), yb = std::min(double(y + 1), p1.y);
        const double dy = yb - ya;
        if (dy <= 0.0) continue;
        const double xa = clampx(p0.x + (ya - p0.y) * dxdy), xb = clampx(p0.x + (yb - p0.y) * dxdy);
        const double d = dy * dir;
        float* row = acc_.data() + size_t(y) * stride;
        const double x0 = std::min(xa, xb), x1 = std::max(xa, xb);
        const double x0floor = std::floor(x0);
        const int x0i = int(x0floor);
        const int x1i = int(std::ceil(x1));
        if (x1i <= x0i + 1) {
            // Within one cell: the trapezoid's share left of its mid-x.
            const double xmf = 0.5 * (xa + xb) - x0floor;
            row[x0i] += float(d - d * xmf);
            row[x0i + 1] += float(d * xmf);
        } else {
            const double s = 1.0 / (x1 - x0);
            const double x0f = x0 - x0floor;
            const double a0 = 0.5 * s * (1.0 - x0f) * (1.0 - x0f);
            const double x1f = x1 - std::ceil(x1) + 1.0;
            const double am = 0.5 * s * x1f * x1f;
            row[x0i] += float(d * a0);
            if (x1i == x0i + 2) {
                row[x0i + 1] += float(d * (1.0 - a0 - am));
            } else {
                const double a1 = s * (1.5 - x0f);
                row[x0i + 1] += float(d * (a1 - a0));
                for (int xi = x0i + 2; xi < x1i - 1; ++xi) row[xi] += float(d * s);
                const double a2 = a1 + double(x1i - x0i - 3) * s;
                row[x1i - 1] += float(d * (1.0 - a2 - am));
            }
            row[x1i] += float(d * am);
        }
    }
}

void Canvas::fill(const std::vector<Contour>& path, double gain) {
    if (w_ <= 0 || h_ <= 0) return;
    std::fill(acc_.begin(), acc_.end(), 0.0f);
    int ymin = h_, ymax = -1;
    for (const Contour& c : path) {
        for (size_t k = 0; k < c.size(); ++k) {
            const Point& a = c[k];
            const Point& b = c[(k + 1) % c.size()];
            line(a, b);
            ymin = std::min(ymin, int(std::floor(std::min(a.y, b.y))));
            ymax = std::max(ymax, int(std::ceil(std::max(a.y, b.y))));
        }
    }
    ymin = std::max(ymin, 0);
    ymax = std::min(ymax, h_);
    const float g = float(std::clamp(gain, 0.0, 1.0));
    const size_t stride = size_t(w_) + 2;
    for (int y = ymin; y < ymax; ++y) {
        const float* row = acc_.data() + size_t(y) * stride;
        float* out = grey_.data() + size_t(y) * size_t(w_);
        float sum = 0.0f;
        for (int x = 0; x < w_; ++x) {
            sum += row[x];
            const float a = std::min(std::fabs(sum), 1.0f);
            if (a > 0.0f) out[x] = g * a + out[x] * (1.0f - a);
        }
    }
}

void Canvas::coverage(std::vector<float>& out) const {
    out.resize(grey_.size());
    for (size_t i = 0; i < grey_.size(); ++i)
        out[i] = std::round(std::clamp(grey_[i], 0.0f, 1.0f) * 255.0f) * (1.0f / 255.0f);
}

Contour circle(Point centre, double r, double px_per_unit) {
    // Chord sagitta r (1 - cos(pi / n)) <= 0.01 px.
    const double rp = std::max(r * px_per_unit, 1e-6);
    const int n = std::clamp(int(std::ceil(M_PI / std::acos(std::max(-1.0, 1.0 - 0.01 / rp)))), 12, 4096);
    Contour c(static_cast<size_t>(n));
    for (int k = 0; k < n; ++k) {
        const double a = 2.0 * M_PI * k / n;
        c[size_t(k)] = {centre.x + r * std::cos(a), centre.y + r * std::sin(a)};
    }
    return c;
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------
namespace {

struct Font {
    std::vector<unsigned char> data;
    stbtt_fontinfo info{};
    double units_per_em = 1000.0;
};

std::mutex g_font_mutex;
std::string g_font_dir;
std::map<std::string, std::unique_ptr<Font>> g_fonts;

const char* file_for(const char* name) {
    const std::string n = name ? name : "";
    if (n == "HelveticaNeue-Bold" || n == "HelveticaNeue-Medium") return "texgyreheros-bold.otf";
    if (n == "ArialNarrow") return "texgyreheroscn-regular.otf";
    if (n == "Menlo-Bold" || n == "Menlo") return "DejaVuSansMono-Bold.ttf";
    return "texgyreheros-regular.otf";
}

const Font* font_for(const char* name) {
    const std::string file = file_for(name);
    std::lock_guard<std::mutex> lock(g_font_mutex);
    auto it = g_fonts.find(file);
    if (it != g_fonts.end()) return it->second.get();
    auto font = std::make_unique<Font>();
    const std::string path = g_font_dir + "/" + file;
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) { g_fonts[file] = nullptr; return nullptr; }
    std::fseek(f, 0, SEEK_END);
    const long size = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    font->data.resize(size_t(std::max(size, 0L)));
    const bool read = size > 0 && std::fread(font->data.data(), 1, font->data.size(), f) == font->data.size();
    std::fclose(f);
    if (!read || !stbtt_InitFont(&font->info, font->data.data(),
                                 stbtt_GetFontOffsetForIndex(font->data.data(), 0))) {
        g_fonts[file] = nullptr;
        return nullptr;
    }
    font->units_per_em = 1.0 / double(stbtt_ScaleForMappingEmToPixels(&font->info, 1.0f));
    const Font* out = font.get();
    g_fonts[file] = std::move(font);
    return out;
}

// UTF-8 to code points; a malformed byte stands for itself.
std::vector<int> codepoints(const std::string& s) {
    std::vector<int> out;
    for (size_t i = 0; i < s.size();) {
        const unsigned char c = static_cast<unsigned char>(s[i]);
        int n = c < 0x80 ? 0 : (c >> 5) == 6 ? 1 : (c >> 4) == 14 ? 2 : (c >> 3) == 30 ? 3 : -1;
        if (n < 0 || i + size_t(n) >= s.size() + (n == 0 ? 1 : 0)) { out.push_back(c); ++i; continue; }
        int cp = n == 0 ? c : n == 1 ? (c & 0x1F) : n == 2 ? (c & 0x0F) : (c & 0x07);
        bool ok = true;
        for (int k = 1; k <= n; ++k) {
            const unsigned char cc = static_cast<unsigned char>(s[i + size_t(k)]);
            if ((cc & 0xC0) != 0x80) { ok = false; break; }
            cp = (cp << 6) | (cc & 0x3F);
        }
        if (!ok) { out.push_back(c); ++i; continue; }
        out.push_back(cp);
        i += size_t(n) + 1;
    }
    return out;
}

void flatten_quad(Point p0, Point p1, Point p2, Contour& out) {
    const double dd = std::hypot(p0.x - 2 * p1.x + p2.x, p0.y - 2 * p1.y + p2.y);
    const int n = std::clamp(int(std::ceil(std::sqrt(dd / 0.05))), 1, 256);
    for (int k = 1; k <= n; ++k) {
        const double t = double(k) / n, u = 1.0 - t;
        out.push_back({u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
                       u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y});
    }
}

void flatten_cubic(Point p0, Point p1, Point p2, Point p3, Contour& out) {
    const double dd = std::max(std::hypot(p0.x - 2 * p1.x + p2.x, p0.y - 2 * p1.y + p2.y),
                               std::hypot(p1.x - 2 * p2.x + p3.x, p1.y - 2 * p2.y + p3.y));
    const int n = std::clamp(int(std::ceil(std::sqrt(1.5 * dd / 0.05))), 1, 256);
    for (int k = 1; k <= n; ++k) {
        const double t = double(k) / n, u = 1.0 - t;
        const double a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
        out.push_back({a * p0.x + b * p1.x + c * p2.x + d * p3.x, a * p0.y + b * p1.y + c * p2.y + d * p3.y});
    }
}

}  // namespace

void set_font_directory(const std::string& dir) {
    std::lock_guard<std::mutex> lock(g_font_mutex);
    if (dir != g_font_dir) g_fonts.clear();
    g_font_dir = dir;
}

bool text_width(const char* name, double size, const std::string& text, double tracking, double& width) {
    const Font* font = font_for(name);
    if (!font) return false;
    const double scale = size / font->units_per_em;
    width = 0.0;
    for (int cp : codepoints(text)) {
        int advance = 0, lsb = 0;
        stbtt_GetCodepointHMetrics(&font->info, cp, &advance, &lsb);
        width += advance * scale + tracking;
    }
    return true;
}

bool text_outline(const char* name, double size, const std::string& text, double tracking,
                  double glyph_xscale, const Affine& to_px, std::vector<Contour>& out) {
    const Font* font = font_for(name);
    if (!font) return false;
    const double scale = size / font->units_per_em;
    double pen = 0.0;
    for (int cp : codepoints(text)) {
        const int glyph = stbtt_FindGlyphIndex(&font->info, cp);
        int advance = 0, lsb = 0;
        stbtt_GetGlyphHMetrics(&font->info, glyph, &advance, &lsb);
        stbtt_vertex* v = nullptr;
        const int n = stbtt_GetGlyphShape(&font->info, glyph, &v);
        // Font units (y up) -> this glyph in text space -> pixels.
        const Affine glyph_to_px = to_px.then_after(
            Affine::translate(pen, 0.0).then_after(Affine::scale(scale * glyph_xscale, scale)));
        auto px = [&](double x, double y) { return glyph_to_px.apply({x, y}); };
        Contour* cur = nullptr;
        Point last{0, 0};
        for (int k = 0; k < n; ++k) {
            const stbtt_vertex& e = v[k];
            const Point p = px(e.x, e.y);
            switch (e.type) {
            case STBTT_vmove:
                out.emplace_back();
                cur = &out.back();
                cur->push_back(p);
                break;
            case STBTT_vline:
                if (cur) cur->push_back(p);
                break;
            case STBTT_vcurve:
                if (cur) flatten_quad(last, px(e.cx, e.cy), p, *cur);
                break;
            case STBTT_vcubic:
                if (cur) flatten_cubic(last, px(e.cx, e.cy), px(e.cx1, e.cy1), p, *cur);
                break;
            default:
                break;
            }
            last = p;
        }
        stbtt_FreeShape(&font->info, v);
        pen += advance * scale + tracking;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Blur
// ---------------------------------------------------------------------------
namespace {

template <class F>
void for_each_line(int lines, F&& fn) {
    const int workers = std::min(lines, int(std::max(1u, std::thread::hardware_concurrency())));
    if (workers <= 1) { for (int i = 0; i < lines; ++i) fn(i); return; }
    std::atomic<int> next{0};
    auto work = [&] { for (int i; (i = next.fetch_add(1)) < lines;) fn(i); };
    std::vector<std::thread> pool;
    for (int t = 1; t < workers; ++t) pool.emplace_back(work);
    work();
    for (auto& th : pool) th.join();
}

}  // namespace

void blur(std::vector<float>& plane, int w, int h, const std::vector<float>& kernel) {
    if (w <= 0 || h <= 0 || kernel.empty()) return;
    const int r = int(kernel.size() / 2);
    std::vector<float> tmp(plane.size());
    for_each_line(h, [&](int y) {
        const float* src = plane.data() + size_t(y) * size_t(w);
        float* dst = tmp.data() + size_t(y) * size_t(w);
        for (int x = 0; x < w; ++x) {
            float acc = 0.0f;
            for (int k = -r; k <= r; ++k) acc += kernel[size_t(k + r)] * src[std::clamp(x + k, 0, w - 1)];
            dst[x] = acc;
        }
    });
    for_each_line(w, [&](int x) {
        for (int y = 0; y < h; ++y) {
            float acc = 0.0f;
            for (int k = -r; k <= r; ++k)
                acc += kernel[size_t(k + r)] * tmp[size_t(std::clamp(y + k, 0, h - 1)) * size_t(w) + size_t(x)];
            plane[size_t(y) * size_t(w) + size_t(x)] = acc;
        }
    });
}

}  // namespace spk::edge
#endif  // !__APPLE__
