// Explicit boundaries for effects added upstream after the first Windows port.
// Included only by Windows call sites; macOS retains its upstream behavior.
//
// Each effect is refused until its kernels and host code are ported; the
// kPorted* switches below flip one at a time, in the commit whose tests pass,
// and the capabilities' `unsupported_features` list is derived from them so
// it can never claim less (or more) than the engine does.
#pragma once
#include <vector>

#include "params.hpp"

namespace spk {

inline constexpr bool kPortedDigitalIntermediate = true;
inline constexpr bool kPortedSceneLatitude = true;
inline constexpr bool kPortedContrastMask = true;
inline constexpr bool kPortedOverscan = false;
inline constexpr bool kPortedDateImprint = false;

inline std::vector<const char*> windows_unported_features() {
    std::vector<const char*> out;
    if (!kPortedDigitalIntermediate) out.push_back("digital_intermediate");
    if (!kPortedSceneLatitude) out.push_back("scene_latitude_mapping");
    if (!kPortedContrastMask) out.push_back("contrast_mask");
    if (!kPortedOverscan) out.push_back("overscan");
    if (!kPortedDateImprint) out.push_back("date_imprint");
    return out;
}

inline const char* windows_unported_error(bool di, bool latitude, bool mask,
                                         bool overscan, bool date) {
    if (di && !kPortedDigitalIntermediate)
        return "digital intermediate is not implemented by the Windows Vulkan backend yet";
    if (latitude && !kPortedSceneLatitude)
        return "scene latitude mapping is not implemented by the Windows Vulkan backend yet";
    if (mask && !kPortedContrastMask)
        return "contrast mask is not implemented by the Windows Vulkan backend yet";
    if (overscan && !kPortedOverscan)
        return "overscan is not implemented by the Windows Vulkan backend yet";
    if (date && !kPortedDateImprint)
        return "date imprint is not implemented by the Windows Vulkan backend yet";
    return nullptr;
}

inline const char* windows_unported_error(const Params& p) {
    return windows_unported_error(p.io.digital_intermediate, p.camera.scene_latitude.active,
                                  p.print_render.contrast_mask.active,
                                  p.film_render.overscan.active, p.film_render.date_imprint.active);
}

// Validate an already schema-checked delta before it mutates the session.
// A valid Windows session cannot already have any of these flags enabled.
inline const char* windows_unported_delta_error(const Json& delta) {
    return windows_unported_error(delta.at("digital_intermediate").as_bool(),
                                  delta.at("scene_latitude_active").as_bool(),
                                  delta.at("contrast_mask_active").as_bool(),
                                  delta.at("overscan_active").as_bool(),
                                  delta.at("date_imprint_active").as_bool());
}

}  // namespace spk
