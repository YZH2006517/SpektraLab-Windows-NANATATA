// Exercise the Windows feature boundary through the exported DLL: every effect
// capabilities lists under unsupported_features must be refused cleanly, and
// every one it does not list must actually render.
#include "spektrafilm/spk_engine.h"

#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

std::string params(spk_session* session) {
    char* json = nullptr;
    require(spk_get_params(session, &json) == SPK_OK && json, "get_params failed");
    std::string result(json);
    spk_string_free(json);
    return result;
}

void render(spk_engine* engine, spk_session* session) {
    spk_result result{};
    const spk_status status = spk_render(session, "full", &result);
    const bool valid = status == SPK_OK && result.rgba16 && result.texture &&
                       result.width == 32 && result.height == 16;
    const std::string error = spk_last_error(engine);
    spk_result_free(&result);
    require(valid, "default render failed after a refused request: " + error);
}

// Turn a ported effect on, render, and turn it off again: the render must
// succeed with pixels, and the session must come back to where it was.
void render_with(spk_engine* engine, spk_session* session, const std::string& key,
                 const std::string& before) {
    const std::string on = "{\"" + key + "\":true}";
    require(spk_set_params(session, on.c_str(), nullptr) == SPK_OK,
            "ported effect refused: " + key + ": " + spk_last_error(engine));
    spk_result result{};
    const spk_status status = spk_render(session, "full", &result);
    const bool valid = status == SPK_OK && result.rgba16 && result.width > 0 && result.height > 0;
    const std::string error = spk_last_error(engine);
    spk_result_free(&result);
    require(valid, "ported effect did not render: " + key + ": " + error);
    const std::string off = "{\"" + key + "\":false}";
    require(spk_set_params(session, off.c_str(), nullptr) == SPK_OK, "could not turn off " + key);
    require(params(session) == before, "turning " + key + " off did not restore the session");
    render(engine, session);
}

}  // namespace

int main(int argc, char** argv) {
    if (argc != 2) { std::cerr << "usage: spk_windows_feature_boundaries resources_dir\n"; return 2; }
    try {
        std::unique_ptr<spk_engine, decltype(&spk_engine_destroy)> engine(
            spk_engine_create(argv[1], nullptr), spk_engine_destroy);
        require(bool(engine), std::string("engine creation failed: ") + spk_last_error(nullptr));
        const char* capabilities = spk_capabilities(engine.get());
        require(capabilities && std::string(capabilities).find("unsupported_features") != std::string::npos,
                "Windows capabilities must disclose unported effects");

        std::vector<float> pixels(32 * 16 * 3);
        for (size_t i = 0; i < pixels.size(); ++i) pixels[i] = 0.025f + float(i % 31) * 0.025f;
        const spk_image input{pixels.data(), 32, 16, 3};
        std::unique_ptr<spk_session, decltype(&spk_session_release)> session(
            spk_open(engine.get(), &input, nullptr, nullptr), spk_session_release);
        require(bool(session), std::string("default open failed: ") + spk_last_error(engine.get()));
        render(engine.get(), session.get());
        const std::string before = params(session.get());

        const std::string caps(capabilities);
        const auto listed = [&](const char* name) {
            return caps.find(std::string("\"") + name + "\"") != std::string::npos;
        };
        struct Feature { const char* key; const char* capability; const char* label; };
        const std::array<Feature, 5> features{{
            {"digital_intermediate", "digital_intermediate", "digital intermediate"},
            {"scene_latitude_active", "scene_latitude_mapping", "scene latitude mapping"},
            {"contrast_mask_active", "contrast_mask", "contrast mask"},
            {"overscan_active", "overscan", "overscan"},
            {"date_imprint_active", "date_imprint", "date imprint"},
        }};
        int ported = 0;
        for (const Feature& feature : features) {
            if (!listed(feature.capability)) {
                render_with(engine.get(), session.get(), feature.key, before);
                ++ported;
                continue;
            }
            // Include a supported change to catch partial application before
            // the unsupported field is rejected.
            const std::string delta = std::string("{\"") + feature.key +
                                      "\":true,\"print_exposure\":1.25}";
            const spk_status status = spk_set_params(session.get(), delta.c_str(), nullptr);
            const std::string error = spk_last_error(engine.get());
            require(status == SPK_ERR_USER && error.find(feature.label) != std::string::npos &&
                    error.find("Windows Vulkan backend") != std::string::npos,
                    std::string("unclear feature refusal: ") + feature.key + ": " + error);
            require(params(session.get()) == before, std::string("refused delta mutated params: ") + feature.key);
            render(engine.get(), session.get());

            spk_session* rejected = spk_open(engine.get(), &input, delta.c_str(), nullptr);
            const std::string open_error = spk_last_error(engine.get());
            if (rejected) spk_session_release(rejected);
            require(!rejected && open_error.find(feature.label) != std::string::npos,
                    std::string("open accepted an unported effect: ") + feature.key);
        }

        spk_result di{};
        char* di_json = nullptr;
        const spk_status di_status = spk_render_digital_intermediate(session.get(), &di, &di_json);
        const std::string di_error = spk_last_error(engine.get());
        const bool empty = !di.texture && !di.rgba16 && !di_json;
        const bool cineon = di_status == SPK_OK && di.rgba16 && di.width == 32 && di.height == 16 &&
                            di_json && std::string(di_json).find("\"cineon\"") != std::string::npos;
        spk_result_free(&di);
        spk_string_free(di_json);
        if (listed("digital_intermediate"))
            require(di_status == SPK_ERR_USER && empty &&
                    di_error.find("digital intermediate") != std::string::npos,
                    "DI API did not return a clear refusal and empty result");
        else
            require(cineon, "DI API did not return a Cineon frame: " + di_error);
        require(params(session.get()) == before, "the DI API mutated the session");
        render(engine.get(), session.get());

        const float* mask = nullptr;
        uint32_t width = 0, height = 0;
        require(spk_contrast_mask_field(session.get(), "full", &mask, &width, &height) == SPK_OK &&
                !mask && width == 0 && height == 0, "disabled contrast mask must have an empty field");

        // Latitude analysis uses the existing pipeline; only applying its
        // mapping is unported. This also exercises probe_medium's readback.
        char* latitude_json = nullptr;
        const spk_status latitude_status = spk_scene_latitude(session.get(), nullptr, &latitude_json);
        const std::string latitude_error = spk_last_error(engine.get());
        const bool latitude_valid = latitude_json &&
            std::string(latitude_json).find("\"medium\"") != std::string::npos &&
            std::string(latitude_json).find("\"scene\"") != std::string::npos;
        spk_string_free(latitude_json);
        require(latitude_status == SPK_OK && latitude_valid, "latitude analysis failed: " + latitude_error);
        require(params(session.get()) == before, "latitude analysis mutated the session");
        render(engine.get(), session.get());
        // A ported effect must change the picture, not just be accepted: a
        // frame spanning ~9 stops, grain and glare off so two sessions are
        // comparable, and each effect with settings that reach that range.
        {
            std::vector<float> ramp(64 * 32 * 3);
            for (uint32_t y = 0; y < 32; ++y)
                for (uint32_t x = 0; x < 64; ++x)
                    for (uint32_t c = 0; c < 3; ++c)
                        ramp[3 * (y * 64 + x) + c] = 0.184f * std::exp2(float(x) / 7.0f - 4.5f) *
                                                     (c == 0 ? 1.1f : c == 2 ? 0.85f : 1.0f);
            const spk_image wide{ramp.data(), 64, 32, 3};
            const std::string quiet = "\"grain_active\":false,\"glare_active\":false";
            auto pixels = [&](const std::string& extra, std::vector<uint16_t>& out) {
                const std::string delta = "{" + quiet + extra + "}";
                std::unique_ptr<spk_session, decltype(&spk_session_release)> s(
                    spk_open(engine.get(), &wide, delta.c_str(), nullptr), spk_session_release);
                require(bool(s), "open with " + delta + ": " + spk_last_error(engine.get()));
                spk_result r{};
                require(spk_render(s.get(), "full", &r) == SPK_OK && r.rgba16,
                        "render with " + delta + ": " + spk_last_error(engine.get()));
                out.assign(r.rgba16, r.rgba16 + size_t(r.row_stride_px) * r.height * 4);
                spk_result_free(&r);
            };
            std::vector<uint16_t> plain;
            pixels("", plain);
            struct Effect { const char* capability; const char* delta; };
            const Effect effects[] = {
                {"scene_latitude_mapping",
                 ",\"scene_latitude_active\":true,\"scene_latitude_highlight_knee\":0.5,"
                 "\"scene_latitude_highlight_room\":1.5,\"scene_latitude_shadow_knee\":-0.5,"
                 "\"scene_latitude_shadow_room\":1.5"},
                {"contrast_mask",
                 ",\"contrast_mask_active\":true,\"contrast_mask_highlights\":2.0,"
                 "\"contrast_mask_shadows\":2.0"},
                {"digital_intermediate", ",\"digital_intermediate\":true"},
            };
            for (const Effect& effect : effects) {
                if (listed(effect.capability)) continue;
                std::vector<uint16_t> with;
                pixels(effect.delta, with);
                size_t moved = 0;
                for (size_t i = 0; i < std::min(plain.size(), with.size()); ++i)
                    moved += std::abs(int(plain[i]) - int(with[i])) > 64;
                require(plain.size() != with.size() || moved > plain.size() / 20,
                        std::string(effect.capability) + " did not change the picture (" +
                        std::to_string(moved) + " samples moved)");
                std::cout << effect.capability << ": " << moved << " of " << plain.size()
                          << " samples moved\n";
            }
        }

        std::cout << "Windows feature boundaries passed (" << ported << " of 5 effects ported and rendered, "
                  << 5 - ported << " refused; DI API, mask off, latitude analysis)\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
