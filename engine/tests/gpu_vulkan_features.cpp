// Independent headless gates for the kernels behind the five effects the first
// Windows port refused (engine/PORT_PLAN.md): each Metal kernel transcribed
// into C++ double as the reference, random and edge-case inputs, guard values
// past the logical output, and a tolerance stated per kernel.
#include "gpu/gpu.hpp"
#include "gpu_vulkan_read.hpp"

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
}  // namespace

int main(int argc, char** argv) {
    if (argc != 2) { std::fprintf(stderr, "usage: spk_vulkan_features <resources>\n"); return 2; }
    std::string error;
    std::unique_ptr<Gpu> gpu(Gpu::create_vulkan(std::string(argv[1]) + "/vulkan", error));
    if (!gpu) { std::fprintf(stderr, "Vulkan device: %s\n", error.c_str()); return 1; }
    std::printf("Vulkan device: %s\n", gpu->device_name().c_str());
    if (!check_di_encode(gpu.get(), error)) {
        std::fprintf(stderr, "features: %s\n", error.c_str());
        return 1;
    }
    std::printf("features: %zu float64-reference cases, max abs error %.9g, all guards intact\n",
                cases, maximum_error);
    return 0;
}
