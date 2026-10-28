// RFC-024's virtual contrast mask, the arithmetic contrast_mask.metal shares
// between spk_mask_reduce and spk_mask_epilogue. The including shader
// declares the buffers `cmy_data`, `chd_data`, `base_data`, `ixs_data` and
// `p_data`.
//
// p: 0..2 the enlarger's setup gain (image exposure only)  3..5 1 / A_ref
//    6..8 the pre-flash offset (epilogue only)
//    9 k_lo 10 h_lo 11 lo_on -- the print-highlight branch
//    12 k_hi 13 h_hi 14 hi_on -- the print-shadow branch
//    15 the gain limit, stops

// The floor under `log2`, relative to mid-grey: 2^-20 is ~6 densities below
// it, far under any paper's toe.
const float kMaskLog2Floor = -20.0;

// vulkan_gpu.cpp folds a dispatch past maxComputeWorkGroupCount[0] (65535 on
// lavapipe and Intel) into rows of workgroups; this is the 1D index it means.
uint spk_global_index() {
    return gl_GlobalInvocationID.y * (gl_NumWorkGroups.x * gl_WorkGroupSize.x) + gl_GlobalInvocationID.x;
}

vec3 mask_image_exposure(uint i, uint nl) {
    float c0 = cmy_data.value[3u * i], c1 = cmy_data.value[3u * i + 1u], c2 = cmy_data.value[3u * i + 2u];
    float a0 = 0.0, a1 = 0.0, a2 = 0.0;
    for (uint l = 0u; l < nl; ++l) {
        float d = c0 * chd_data.value[3u * l] + c1 * chd_data.value[3u * l + 1u] +
                  c2 * chd_data.value[3u * l + 2u] + base_data.value[l];
        float t = exp2(-d * 3.321928094887362);
        a0 += t * ixs_data.value[3u * l]; a1 += t * ixs_data.value[3u * l + 1u];
        a2 += t * ixs_data.value[3u * l + 2u];
    }
    return vec3(a0 * p_data.value[0], a1 * p_data.value[1], a2 * p_data.value[2]);
}

float mask_x(vec3 a) {
    float s = 0.0;
    for (uint c = 0u; c < 3u; ++c) {
        float r = a[c] * p_data.value[3u + c];
        // Metal: max(log2(max(r, 0)), floor), with log2(0) = -inf and fmax's
        // NaN rule. GLSL leaves log2(0) and max(NaN, x) undefined, so the
        // floor is taken explicitly for everything that is not positive.
        s += r > 0.0 ? max(log2(r), kMaskLog2Floor) : kMaskLog2Floor;
    }
    return s * (1.0 / 3.0);
}

// RFC-023's m = 2 branch, `D * H / sqrt(H^2 + D^2)`: slope 1 at the knee,
// asymptote H.
float mask_g(float d, float h) { return d * h * inversesqrt(h * h + d * d); }

// delta = f(b) - b, bounded. Exactly 0.0 inside the core and on a disabled
// branch, so the gain there is exp2(0) = 1.
float mask_delta(float b) {
    float delta = 0.0;
    if (p_data.value[11] != 0.0 && b < p_data.value[9]) {
        float d = p_data.value[9] - b;
        delta = d - mask_g(d, p_data.value[10]);
    } else if (p_data.value[14] != 0.0 && b > p_data.value[12]) {
        float d = b - p_data.value[12];
        delta = mask_g(d, p_data.value[13]) - d;
    }
    float lim = p_data.value[15];
    return delta * lim * inversesqrt(lim * lim + delta * delta);
}
