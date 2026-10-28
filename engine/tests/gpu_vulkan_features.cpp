// Independent headless gates for the kernels behind the five effects the first
// Windows port refused (engine/PORT_PLAN.md): each Metal kernel transcribed
// into C++ double as the reference, random and edge-case inputs, guard values
// past the logical output, and a tolerance stated per kernel.
#include "gpu/gpu.hpp"
#include "gpu_vulkan_read.hpp"
#include "latitude_fit.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <limits>
#include <memory>
#include <random>
#include <string>
#include <vector>

namespace {
using spk::gpu::Arg;
using spk::gpu::BufferRef;
using spk::gpu::Gpu;
using spk::SceneLatitudeParams;
constexpr float kGuard = -12345.25f;
constexpr size_t kGuardCount = 11;
size_t cases = 0;
double maximum_error = 0;

BufferRef output_buffer(Gpu* gpu, size_t count, std::string& error) {
    const std::vector<float> guarded(count + kGuardCount, kGuard);
    return gpu->upload(guarded.data(), guarded.size() * sizeof(float), error);
}

bool check_values(Gpu* gpu, const BufferRef& output, const std::vector<double>& expected,
                  const char* name, double absolute_tolerance, double relative_tolerance,
                  std::string& error) {
    if (!gpu->flush(error)) return false;
    std::vector<float> actual;
    if (!read_test_buffer(gpu, output, actual, error)) return false;
    for (size_t i = 0; i < expected.size(); ++i) {
        const double delta = std::fabs(double(actual[i]) - expected[i]);
        const double tolerance = absolute_tolerance + relative_tolerance * std::fabs(expected[i]);
        const bool ok = std::isnan(expected[i]) ? std::isnan(actual[i])
                      : std::isinf(expected[i]) ? double(actual[i]) == expected[i]
                      : std::isfinite(actual[i]) && delta <= tolerance;
        if (!ok) {
            char detail[320];
            std::snprintf(detail, sizeof detail,
                "%s case=%zu index=%zu got=%.9g expected=%.17g delta=%.9g tolerance=%.9g",
                name, cases, i, double(actual[i]), expected[i], delta, tolerance);
            error = detail;
            return false;
        }
        if (std::isfinite(delta)) maximum_error = std::max(maximum_error, delta);
    }
    for (size_t i = expected.size(); i < expected.size() + kGuardCount; ++i) {
        if (actual[i] != kGuard) {
            error = std::string(name) + " wrote past its logical output count";
            return false;
        }
    }
    ++cases;
    return true;
}

// ---------------------------------------------------------------------------
// spk_di_encode (nodes.metal), RFC-028's Cineon pass
// ---------------------------------------------------------------------------

void di_reference(const float* y, const std::vector<float>& pf, double out[3]) {
    auto p = [&](int k) { return double(pf[size_t(k)]); };
    double pos[3];
    for (int c = 0; c < 3; ++c)
        pos[c] = std::pow(10.0, double(y[c]) + p(9 + c)) - p(40) * std::pow(10.0, p(9 + c));
    double lin[3];
    for (int c = 0; c < 3; ++c) lin[c] = pos[0] * p(c) + pos[1] * p(3 + c) + pos[2] * p(6 + c);
    if (p(30) != 0.0) {
        double lms[3];
        for (int r = 0; r < 3; ++r)
            lms[r] = std::cbrt(std::max(p(12 + 3 * r) * lin[0] + p(13 + 3 * r) * lin[1] +
                                        p(14 + 3 * r) * lin[2], 0.0));
        const double L = 0.2104542553 * lms[0] + 0.7936177850 * lms[1] - 0.0040720468 * lms[2];
        double a = 1.9779984951 * lms[0] - 2.4285922050 * lms[1] + 0.4505937099 * lms[2];
        double b = 0.0259040371 * lms[0] + 0.7827717662 * lms[1] - 0.8086757660 * lms[2];
        const double C = std::sqrt(a * a + b * b);
        const double h = std::atan2(b, a) * 57.29577951308232;
        const double d = std::fmod(h - p(33) + 540.0, 360.0) - 180.0;
        double w = std::fabs(d) < p(34) ? 0.5 * (1.0 + std::cos(3.14159265358979 * d / p(34))) : 0.0;
        const double g = std::clamp((C - p(35)) / (p(36) - p(35)), 0.0, 1.0);
        w *= g * g * (3.0 - 2.0 * g);
        if (w > 0.0) {
            const double h2 = (h + w * p(31)) * 0.017453292519943295;
            const double C2 = C * (1.0 + w * (p(32) - 1.0));
            a = C2 * std::cos(h2);
            b = C2 * std::sin(h2);
            const double l_[3] = {L + 0.3963377774 * a + 0.2158037573 * b,
                                  L - 0.1055613458 * a - 0.0638541728 * b,
                                  L - 0.0894841775 * a - 1.2914855480 * b};
            for (int r = 0; r < 3; ++r) lms[r] = l_[r] * l_[r] * l_[r];
            for (int r = 0; r < 3; ++r)
                lin[r] = p(21 + 3 * r) * lms[0] + p(22 + 3 * r) * lms[1] + p(23 + 3 * r) * lms[2];
        }
    }
    for (int c = 0; c < 3; ++c) {
        const double code = (p(37) + p(38) * std::log10(std::max(lin[c], 0.0) * (1.0 - p(41)) + p(41))) / p(39);
        out[c] = std::clamp(code, 0.0, 1.0);
    }
}

bool check_di_encode(Gpu* gpu, std::string& error) {
    // Linear sRGB <-> Oklab LMS (Ottosson), so the hue window lands on real hues.
    const float to_lms[9] = {0.4122214708f, 0.5363325363f, 0.0514459929f,
                             0.2119034982f, 0.6806995451f, 0.1073969566f,
                             0.0883024619f, 0.2817188376f, 0.6299787005f};
    const float from_lms[9] = {4.0767416621f, -3.3077115913f, 0.2309699292f,
                               -1.2684380046f, 2.6097574011f, -0.3413193965f,
                               -0.0041960863f, -0.7034186147f, 1.7076147010f};
    std::mt19937 rng(28);
    std::uniform_real_distribution<float> density(-3.0f, 0.5f);
    const uint32_t counts[] = {0, 1, 255, 256, 257, 4099};
    for (int compensate = 0; compensate < 2; ++compensate)
        for (uint32_t count : counts) {
            std::vector<float> p(42, 0.0f);
            const float film_to_working[9] = {1.05f, -0.03f, 0.01f, -0.04f, 0.98f, -0.02f, 0.02f, 0.05f, 1.01f};
            std::copy(film_to_working, film_to_working + 9, p.begin());
            p[9] = 0.12f; p[10] = -0.05f; p[11] = 0.31f;
            std::copy(to_lms, to_lms + 9, p.begin() + 12);
            std::copy(from_lms, from_lms + 9, p.begin() + 21);
            p[30] = float(compensate);
            p[31] = -12.0f; p[32] = 0.85f;
            p[33] = 250.0f; p[34] = 60.0f; p[35] = 0.01f; p[36] = 0.06f;  // blues and their neighbours
            p[37] = 685.0f; p[38] = 300.0f; p[39] = 1023.0f; p[40] = 0.0021f; p[41] = 0.0108f;
            std::vector<float> y(3 * size_t(std::max(count, 1u)));
            for (auto& v : y) v = density(rng);
            if (count > 4) {
                y[0] = y[1] = y[2] = -0.4f;                                // grey
                y[3] = -6.0f; y[4] = -6.0f; y[5] = -6.0f;                  // below the base: black
                y[6] = 2.0f; y[7] = 2.0f; y[8] = 2.0f;                     // above white: clipped
                y[9] = -0.2f; y[10] = -1.2f; y[11] = 0.1f;                 // saturated, in the window
            }
            std::vector<double> expected(3 * size_t(count));
            for (uint32_t i = 0; i < count; ++i) di_reference(&y[3 * size_t(i)], p, &expected[3 * size_t(i)]);
            auto input = gpu->upload(y.data(), y.size() * sizeof(float), error);
            auto params = gpu->upload(p.data(), p.size() * sizeof(float), error);
            auto output = output_buffer(gpu, 3 * size_t(count), error);
            const uint32_t n[1] = {count};
            if (!input || !params || !output ||
                !gpu->dispatch("spk_di_encode", {Arg::buf(input), Arg::buf(params),
                                   Arg::inline_bytes(n, 1), Arg::buf(output)},
                               std::max(count, 1u), error) ||
                // Codes are 0..1 over 1023 steps; 6e-5 is a sixteenth of one
                // 10-bit code. A float32 CPU transcription of the Metal kernel
                // itself reaches 4.06e-5 from this double reference (6 M
                // samples, measured 2026-10-28) at the hue window's edges, so
                // the bar is float32's, not a looser one for Vulkan.
                !check_values(gpu, output, expected, "di_encode", 6e-5, 0.0, error)) return false;
        }
    return true;
}
// ---------------------------------------------------------------------------
// spk_scene_latitude (scene_latitude.metal), RFC-023; the reference is the
// engine's own double-precision `slm::delta`
// ---------------------------------------------------------------------------

bool check_scene_latitude(Gpu* gpu, std::string& error) {
    struct Layout { uint32_t w, h, row0; float split; };
    const Layout layouts[] = {{97, 41, 0, 0.0f}, {97, 41, 0, 0.45f}, {23, 61, 0, 0.5f}, {23, 61, 17, 0.5f}};
    const float rolloffs[] = {1.0f, 2.0f, 2.7f};
    const float y_row[3] = {0.2126729f, 0.7151522f, 0.0721750f};
    const float n_ref = float(spk::slm::kMidgray);
    std::mt19937 rng(23);
    std::uniform_real_distribution<float> stops(-14.0f, 10.0f), tint(-0.6f, 0.6f);
    for (uint32_t norm = 0; norm < 3; ++norm)
        for (float m : rolloffs)
            for (const Layout& layout : layouts) {
                SceneLatitudeParams a, b;
                a.highlight_knee = 1.5; a.highlight_room = 2.5; a.shadow_knee = -2.25; a.shadow_room = 3.0;
                a.rolloff = m; a.max_lift = 2.0;
                b = a;
                b.highlight_knee = 0.75; b.highlight_room = 1.25; b.shadow_knee = -3.0; b.shadow_room = 0.0;
                const float p[19] = {float(a.highlight_knee), float(a.highlight_room),
                                     float(a.shadow_knee), float(a.shadow_room), m, float(a.max_lift),
                                     float(norm), y_row[0], y_row[1], y_row[2], n_ref,
                                     float(layout.w), float(layout.h + layout.row0), layout.split,
                                     float(b.highlight_knee), float(b.highlight_room),
                                     float(b.shadow_knee), float(b.shadow_room), float(layout.row0)};
                // Round-tripped through float, as the kernel sees them.
                for (SceneLatitudeParams* s : {&a, &b}) {
                    s->highlight_knee = float(s->highlight_knee); s->shadow_knee = float(s->shadow_knee);
                    s->rolloff = float(s->rolloff);
                }
                const uint32_t count = layout.w * layout.h;
                std::vector<float> rgb(3 * size_t(count));
                for (uint32_t i = 0; i < count; ++i) {
                    const float level = n_ref * std::exp2(stops(rng));
                    for (int c = 0; c < 3; ++c) rgb[3 * i + c] = level * std::exp2(tint(rng));
                }
                const float inf = std::numeric_limits<float>::infinity();
                const float nan = std::numeric_limits<float>::quiet_NaN();
                const float edge[][3] = {{0, 0, 0}, {-1, -2, -3}, {-0.5f, 0.3f, 0.02f}, {nan, 0.2f, 0.2f},
                                         {inf, 1, 1}, {1e-30f, 1e-30f, 1e-30f}, {3e4f, 2e4f, 1e4f},
                                         {n_ref, n_ref, n_ref}};
                for (size_t e = 0; e < std::size(edge); ++e)
                    for (int c = 0; c < 3; ++c) rgb[3 * e + c] = edge[e][c];

                std::vector<double> expected(rgb.size());
                for (uint32_t i = 0; i < count; ++i) {
                    // The norm in float, as the kernel computes it: whether it
                    // underflows to 0 (k = 1) is the kernel's behaviour, not
                    // an error to measure. Metal's max is fmax: a NaN
                    // component reads as 0.
                    const float cr = std::fmax(rgb[3 * i], 0.0f);
                    const float cg = std::fmax(rgb[3 * i + 1], 0.0f);
                    const float cb = std::fmax(rgb[3 * i + 2], 0.0f);
                    float vf;
                    if (norm == 1) vf = y_row[0] * cr + y_row[1] * cg + y_row[2] * cb;
                    else if (norm == 2) vf = std::max(cr, std::max(cg, cb));
                    else {
                        const float s2 = cr * cr + cg * cg + cb * cb;
                        vf = s2 > 0.0f ? (cr * cr * cr + cg * cg * cg + cb * cb * cb) / s2 : 0.0f;
                    }
                    const double v = vf;
                    double k = 1.0;
                    if (v > 0.0 && std::isfinite(v)) {
                        const double E = std::clamp(std::log2(std::max(v, n_ref * std::exp2(-24.0)) / n_ref),
                                                    -24.0, 24.0);
                        const SceneLatitudeParams* side = &a;
                        if (layout.split > 0.0f) {
                            const double along = layout.w >= layout.h + layout.row0
                                ? (double(i % layout.w) + 0.5) / layout.w
                                : (double(i / layout.w) + layout.row0 + 0.5) / (layout.h + layout.row0);
                            if (along >= layout.split) side = &b;
                        }
                        k = std::clamp(std::exp2(spk::slm::delta(E, *side)), std::exp2(-30.0), std::exp2(30.0));
                    }
                    for (int c = 0; c < 3; ++c) expected[3 * i + c] = double(rgb[3 * i + c]) * k;
                }
                auto input = gpu->upload(rgb.data(), rgb.size() * sizeof(float), error);
                auto params = gpu->upload(p, sizeof p, error);
                auto output = output_buffer(gpu, rgb.size(), error);
                const uint32_t n[1] = {count};
                if (!input || !params || !output ||
                    !gpu->dispatch("spk_scene_latitude", {Arg::buf(input), Arg::buf(params),
                                       Arg::inline_bytes(n, 1), Arg::buf(output)}, count, error) ||
                    // A gain is 2^d: float32 log2/pow/exp2 over |E| <= 24 stops
                    // keep d within ~4e-7 stops, i.e. ~3e-7 relative in k.
                    !check_values(gpu, output, expected, "scene_latitude", 1e-37, 3e-6, error)) return false;
            }
    return true;
}
// ---------------------------------------------------------------------------
// spk_mask_reduce / spk_mask_epilogue (contrast_mask.metal), RFC-024
// ---------------------------------------------------------------------------

struct MaskData {
    uint32_t nl = 81;
    std::vector<float> chd, base, ixs, p;
};

MaskData mask_data(std::mt19937& rng, bool lo_on, bool hi_on) {
    MaskData m;
    std::uniform_real_distribution<float> unit(0.0f, 1.0f);
    m.chd.resize(3 * m.nl); m.base.resize(m.nl); m.ixs.resize(3 * m.nl);
    for (auto& v : m.chd) v = 0.05f + unit(rng);
    for (auto& v : m.base) v = 0.02f + 0.1f * unit(rng);
    for (auto& v : m.ixs) v = (0.1f + unit(rng)) / float(m.nl);
    m.p = {1.7f, 1.3f, 0.9f,  2.1f, 2.6f, 3.4f,  0.004f, 0.003f, 0.002f,
           -1.2f, 1.5f, lo_on ? 1.0f : 0.0f,  1.1f, 1.25f, hi_on ? 1.0f : 0.0f,  1.75f};
    return m;
}

void mask_exposure_ref(const MaskData& m, const float* c, double a[3]) {
    double acc[3] = {0, 0, 0};
    for (uint32_t l = 0; l < m.nl; ++l) {
        double d = double(m.base[l]);
        for (int k = 0; k < 3; ++k) d += double(c[k]) * m.chd[3 * l + k];
        const double t = std::pow(10.0, -d);
        for (int k = 0; k < 3; ++k) acc[k] += t * m.ixs[3 * l + k];
    }
    for (int k = 0; k < 3; ++k) a[k] = acc[k] * m.p[k];
}

double mask_x_ref(const MaskData& m, const double a[3]) {
    double s = 0;
    for (int c = 0; c < 3; ++c) {
        const double r = a[c] * m.p[3 + c];
        s += r > 0.0 ? std::max(std::log2(r), -20.0) : -20.0;
    }
    return s / 3.0;
}

double mask_delta_ref(const MaskData& m, double b) {
    auto g = [](double d, double h) { return d * h / std::sqrt(h * h + d * d); };
    double delta = 0;
    if (m.p[11] != 0 && b < m.p[9]) { const double d = m.p[9] - b; delta = d - g(d, m.p[10]); }
    else if (m.p[14] != 0 && b > m.p[12]) { const double d = b - m.p[12]; delta = g(d, m.p[13]) - d; }
    const double lim = m.p[15];
    return delta * lim / std::sqrt(lim * lim + delta * delta);
}

bool check_contrast_mask(Gpu* gpu, std::string& error) {
    std::mt19937 rng(24);
    std::uniform_real_distribution<float> density(0.0f, 2.5f), slope(0.0f, 1.0f), offset(-3.0f, 3.0f);
    struct Grid { uint32_t W, H, gw, gh, row0, band; };
    const Grid grids[] = {{64, 48, 8, 6, 0, 48}, {101, 37, 13, 5, 0, 37}, {50, 90, 7, 11, 23, 31},
                          {5, 3, 1, 1, 0, 3}, {300, 200, 40, 27, 0, 200}};
    for (int branches = 0; branches < 4; ++branches)
        for (const Grid& grid : grids) {
            const MaskData m = mask_data(rng, branches & 1, branches & 2);
            const uint32_t count = grid.W * grid.H;
            std::vector<float> cmy(3 * size_t(count));
            for (auto& v : cmy) v = density(rng);
            if (count > 3) { cmy[0] = cmy[1] = cmy[2] = 0.0f; cmy[3] = cmy[4] = cmy[5] = 40.0f; }  // clear / opaque
            auto chd = gpu->upload(m.chd.data(), m.chd.size() * sizeof(float), error);
            auto base = gpu->upload(m.base.data(), m.base.size() * sizeof(float), error);
            auto ixs = gpu->upload(m.ixs.data(), m.ixs.size() * sizeof(float), error);
            auto p = gpu->upload(m.p.data(), m.p.size() * sizeof(float), error);
            auto in = gpu->upload(cmy.data(), cmy.size() * sizeof(float), error);
            if (!chd || !base || !ixs || !p || !in) return false;

            // The reduce, over the whole frame.
            const uint32_t cells = grid.gw * grid.gh;
            std::vector<double> means(cells);
            for (uint32_t cell = 0; cell < cells; ++cell) {
                const uint32_t cy = cell / grid.gw, cx = cell % grid.gw;
                const uint32_t x0 = cx * grid.W / grid.gw, y0 = cy * grid.H / grid.gh;
                const uint32_t x1 = std::min(std::max((cx + 1) * grid.W / grid.gw, x0 + 1), grid.W);
                const uint32_t y1 = std::min(std::max((cy + 1) * grid.H / grid.gh, y0 + 1), grid.H);
                double acc = 0;
                for (uint32_t y = y0; y < y1; ++y)
                    for (uint32_t x = x0; x < x1; ++x) {
                        double a[3];
                        mask_exposure_ref(m, &cmy[3 * size_t(y * grid.W + x)], a);
                        acc += mask_x_ref(m, a);
                    }
                means[cell] = acc / double((x1 - x0) * (y1 - y0));
            }
            auto reduced = output_buffer(gpu, cells, error);
            const uint32_t reduce_meta[5] = {grid.W, grid.H, grid.gw, grid.gh, m.nl};
            if (!reduced ||
                !gpu->dispatch("spk_mask_reduce", {Arg::buf(in), Arg::buf(chd), Arg::buf(base), Arg::buf(ixs),
                                   Arg::buf(p), Arg::inline_bytes(reduce_meta, 5), Arg::buf(reduced)},
                               cells, error) ||
                // x is a mean of log2s of float spectral sums: ~1e-6 per pixel.
                !check_values(gpu, reduced, means, "mask_reduce", 2e-5, 1e-6, error)) return false;

            // The epilogue, over a band of the frame read at the frame's rows.
            std::vector<float> coefficients(2 * size_t(cells));
            for (uint32_t cell = 0; cell < cells; ++cell) {
                coefficients[2 * cell] = slope(rng);
                coefficients[2 * cell + 1] = offset(rng);
            }
            auto coef = gpu->upload(coefficients.data(), coefficients.size() * sizeof(float), error);
            const uint32_t n = grid.W * grid.band;
            const float* band = &cmy[3 * size_t(grid.row0) * grid.W];
            auto band_in = gpu->upload(band, 3 * size_t(n) * sizeof(float), error);
            std::vector<double> expected(3 * size_t(n));
            for (uint32_t i = 0; i < n; ++i) {
                double a[3];
                mask_exposure_ref(m, band + 3 * size_t(i), a);
                const uint32_t px = i % grid.W, py = grid.row0 + i / grid.W;
                // The grid coordinate in float, as the kernel computes it.
                const float u = std::clamp((float(px) + 0.5f) * float(grid.gw) / float(grid.W) - 0.5f,
                                           0.0f, float(grid.gw - 1));
                const float v = std::clamp((float(py) + 0.5f) * float(grid.gh) / float(grid.H) - 0.5f,
                                           0.0f, float(grid.gh - 1));
                const uint32_t u0 = uint32_t(std::floor(u)), v0 = uint32_t(std::floor(v));
                const uint32_t u1 = std::min(u0 + 1, grid.gw - 1), v1 = std::min(v0 + 1, grid.gh - 1);
                const double tu = u - float(u0), tv = v - float(v0);
                double ab[2];
                for (int k = 0; k < 2; ++k) {
                    auto c = [&](uint32_t row, uint32_t col) { return double(coefficients[2 * (row * grid.gw + col) + k]); };
                    const double top = c(v0, u0) + (c(v0, u1) - c(v0, u0)) * tu;
                    const double bottom = c(v1, u0) + (c(v1, u1) - c(v1, u0)) * tu;
                    ab[k] = top + (bottom - top) * tv;
                }
                const double gain = std::exp2(mask_delta_ref(m, ab[0] * mask_x_ref(m, a) + ab[1]));
                for (int c = 0; c < 3; ++c)
                    expected[3 * size_t(i) + c] = std::log10(std::max(gain * a[c] + m.p[6 + c], 0.0) + 1e-10);
            }
            auto out = output_buffer(gpu, 3 * size_t(n), error);
            const uint32_t meta[7] = {n, m.nl, grid.W, grid.H, grid.row0, grid.gw, grid.gh};
            if (!coef || !band_in || !out ||
                !gpu->dispatch("spk_mask_epilogue", {Arg::buf(band_in), Arg::buf(chd), Arg::buf(base),
                                   Arg::buf(ixs), Arg::buf(p), Arg::buf(coef), Arg::inline_bytes(meta, 7),
                                   Arg::buf(out)}, n, error) ||
                // log10 of an 81-term float spectral sum, scaled by a gain that
                // went through log2 -> the curve -> exp2: 3.04e-6 measured worst
                // over these cases. 1e-5 in log10 is 2.3e-5 relative exposure,
                // under the engine's whole-image parity bar (3e-5 of full scale).
                !check_values(gpu, out, expected, "mask_epilogue", 1e-5, 0.0, error)) return false;
        }
    return true;
}
}  // namespace

int main(int argc, char** argv) {
    if (argc != 2) { std::fprintf(stderr, "usage: spk_vulkan_features <resources>\n"); return 2; }
    std::string error;
    std::unique_ptr<Gpu> gpu(Gpu::create_vulkan(std::string(argv[1]) + "/vulkan", error));
    if (!gpu) { std::fprintf(stderr, "Vulkan device: %s\n", error.c_str()); return 1; }
    std::printf("Vulkan device: %s\n", gpu->device_name().c_str());
    if (!check_di_encode(gpu.get(), error) || !check_scene_latitude(gpu.get(), error) ||
        !check_contrast_mask(gpu.get(), error)) {
        std::fprintf(stderr, "features: %s\n", error.c_str());
        return 1;
    }
    std::printf("features: %zu float64-reference cases, max abs error %.9g, all guards intact\n",
                cases, maximum_error);
    return 0;
}
