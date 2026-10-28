// RFC-032 §26-§31: the film outside the frame (overscan.metal), the geometry
// its kernels share. The including shader declares the parameter block as
// `p_data` (layout: overscan.cpp `enum OsP`, the single source of indices).
// Film millimetres: `s` along the film, `t` across it, `t = 0` at the film's
// first long edge.

const uint P_CW = 0u, P_CH = 1u, P_PX = 2u, P_FW = 3u, P_FH = 4u;
const uint P_A00 = 5u, P_A01 = 6u, P_A10 = 7u, P_A11 = 8u, P_CS = 9u, P_CT = 10u, P_CU = 11u, P_CV = 12u;
const uint P_VERTICAL = 13u;
const uint P_GS0 = 14u, P_GT0 = 15u, P_GW = 16u, P_GH = 17u, P_CORNER = 18u, P_PENUMBRA = 19u;
const uint P_WOB_A = 20u, P_WOB_PH = 32u;
const uint P_FILM_W = 44u, P_FOG_AMP = 45u, P_FOG_WIDTH = 46u, P_FOG_SEED = 47u, P_FOG_PERIOD = 48u;
const uint P_FOG_R = 49u, P_FOG_G = 50u, P_FOG_B = 51u;
const uint P_N_LEAKS = 52u;
const uint P_PERFORATED = 83u, P_PERF_PITCH = 84u, P_PERF_W = 85u, P_PERF_H = 86u, P_PERF_EDGE = 87u;
const uint P_PERF_R = 88u, P_PERF_PHASE = 89u;
const uint P_HOLE_C = 90u, P_HOLE_M = 91u, P_HOLE_Y = 92u;
const uint P_FLARE_AMP = 93u, P_FLARE_WIDTH = 94u;
const uint P_GATE_R = 95u;
const uint P_N_Q = 99u, P_Q = 100u;
const uint P_ROUGH_AMP = 180u, P_ROUGH_PERIOD = 181u, P_ROUGH_SEED = 182u;
const uint P_HOLES_LIGHT = 183u, P_LIGHT_R = 184u, P_LIGHT_G = 185u, P_LIGHT_B = 186u;
const uint P_PERF_SEED = 187u, P_LIGHT_FALL = 188u, P_LIGHT_DIR = 189u;
const uint P_WALL_T = 190u, P_WALL_VS = 191u, P_WALL_VT = 192u, P_WALL_PAR = 193u;
const uint P_BASE_R = 194u, P_BASE_G = 195u, P_BASE_B = 196u, P_WALL_GLOW = 197u, P_WALL_SCATTER = 198u;
const uint P_CARRIER = 199u;
const uint P_LEAKS = 200u;
const uint P_PAIR_ADV = 260u;
const uint kQStride = 10u;
const float M_PI_F = 3.14159265358979;

float P(uint k) { return p_data.value[k]; }

// vulkan_gpu.cpp folds a dispatch past maxComputeWorkGroupCount[0] (65535 on
// lavapipe and Intel) into rows of workgroups; this is the 1D index it means.
uint spk_global_index() {
    return gl_GlobalInvocationID.y * (gl_NumWorkGroups.x * gl_WorkGroupSize.x) + gl_GlobalInvocationID.x;
}

vec2 canvas_to_film(float x, float y) {
    precise float u = (x + 0.5) * P(P_PX) - P(P_CU);
    precise float v = (y + 0.5) * P(P_PX) - P(P_CV);
    precise vec2 st = vec2(P(P_A00) * u + P(P_A01) * v + P(P_CS), P(P_A10) * u + P(P_A11) * v + P(P_CT));
    return st;
}

uint hash_u(uint x) {
    x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
    return x;
}
float hash_f(int i, uint seed) { return float(hash_u(uint(i) * 0x9E3779B9u ^ seed)) * (1.0 / 4294967295.0); }
float value_noise(float x, uint seed) {
    float i0 = floor(x), f = x - i0;
    float w = f * f * (3.0 - 2.0 * f);
    return mix(hash_f(int(i0), seed), hash_f(int(i0) + 1, seed), w);
}

// Signed distance to a convex quad (either winding; a repeated vertex makes a
// triangle), negative inside. `q` is the quad's first index in the block.
float sd_quad(vec2 p, uint q) {
    vec2 v[4] = vec2[4](vec2(P(q), P(q + 1u)), vec2(P(q + 2u), P(q + 3u)),
                        vec2(P(q + 4u), P(q + 5u)), vec2(P(q + 6u), P(q + 7u)));
    float d = dot(p - v[0], p - v[0]);
    float sgn = 1.0;
    for (uint i = 0u, j = 3u; i < 4u; j = i, ++i) {
        vec2 e = v[j] - v[i], w = p - v[i];
        float ee = dot(e, e);
        if (ee < 1e-12) continue;
        vec2 b = w - e * clamp(dot(w, e) / ee, 0.0, 1.0);
        d = min(d, dot(b, b));
        bool c0 = p.y >= v[i].y, c1 = p.y < v[j].y, c2 = e.x * w.y > e.y * w.x;
        if ((c0 && c1 && c2) || (!c0 && !c1 && !c2)) sgn = -sgn;
    }
    return sgn * sqrt(d);
}

// The gate (RFC-032 §29): per-corner radii, quads and ellipses that add to or
// cut from the opening, the machined edge's roughness, each side's wobble.
// Signed distance, negative inside, in mm.
float gate_sdf(vec2 st) {
    float hw = 0.5 * P(P_GW), hh = 0.5 * P(P_GH);
    float ds = st.x - (P(P_GS0) + hw), dt = st.y - (P(P_GT0) + hh);
    float r = ds > 0.0 ? (dt > 0.0 ? P(P_GATE_R + 2u) : P(P_GATE_R + 1u))
                       : (dt > 0.0 ? P(P_GATE_R + 3u) : P(P_GATE_R + 0u));
    float qs = abs(ds) - (hw - r), qt = abs(dt) - (hh - r);
    float d = length(max(vec2(qs, qt), 0.0)) + min(max(qs, qt), 0.0) - r;
    uint side; float along, len;
    if (qs > qt) { side = ds > 0.0 ? 1u : 3u; along = dt + hh; len = 2.0 * hh; }
    else         { side = dt > 0.0 ? 2u : 0u; along = ds + hw; len = 2.0 * hw; }
    float u = clamp(along / len, 0.0, 1.0);
    float w = 0.0;
    for (uint k = 0u; k < 3u; ++k)
        w += P(P_WOB_A + side * 3u + k) * sin(float(k + 1u) * M_PI_F * u + P(P_WOB_PH + side * 3u + k));
    d -= w * sin(M_PI_F * u);
    uint nq = uint(P(P_N_Q));
    for (uint k = 0u; k < nq; ++k) {
        uint q = P_Q + kQStride * k;
        float dq;
        if (abs(P(q + 9u)) > 1.5) {
            // an ellipse: centre q[0..1], radii q[2..3]; distance scaled by the
            // smaller radius, exact on the boundary, which is all a penumbra reads
            vec2 rr = max(vec2(P(q + 2u), P(q + 3u)), vec2(1e-4));
            dq = (length((st - vec2(P(q), P(q + 1u))) / rr) - 1.0) * min(rr.x, rr.y);
        } else {
            dq = sd_quad(st, q) - P(q + 8u);
        }
        d = P(q + 9u) > 0.0 ? min(d, dq) : max(d, -dq);
    }
    if (P(P_ROUGH_AMP) > 0.0) {
        uint seed = uint(P(P_ROUGH_SEED));
        float per = max(P(P_ROUGH_PERIOD), 1e-3);
        d += P(P_ROUGH_AMP) * (value_noise(st.x / per, seed) + value_noise(st.y / per, seed ^ 0x5bd1e995u) - 1.0);
    }
    return d;
}

// The lit fraction of a disc of radius r cut by a straight edge at signed
// distance d: the gate's shadow from a circular aperture.
float penumbra(float d, float r) {
    if (r <= 1e-6) return d < 0.0 ? 1.0 : 0.0;
    float u = clamp(-d / r, -1.0, 1.0);
    return 0.5 + (u * sqrt(max(1.0 - u * u, 0.0)) + asin(u)) * (1.0 / M_PI_F);
}

// The nearest perforation's signed distance (mm, negative inside), and that
// hole's own hash (row and index).
float perf_sdf(vec2 st, out uint hole) {
    float W = P(P_FILM_W);
    float pitch = P(P_PERF_PITCH), ph = P(P_PERF_PHASE);
    float k = floor((st.x - ph - 0.5 * P(P_PERF_W)) / pitch + 0.5);
    bool top = st.y < 0.5 * W;
    uint seed = uint(P(P_PERF_SEED));
    hole = hash_u(uint(int(k) * 2 + (top ? 0 : 1)) * 0x9E3779B9u ^ seed);
    int hi = int(hole & 0xFFFFu);
    float j0 = hash_f(hi, seed ^ 0x1u) - 0.5, j1 = hash_f(hi, seed ^ 0x2u) - 0.5;
    float j2 = hash_f(hi, seed ^ 0x3u) - 0.5, j3 = hash_f(hi, seed ^ 0x4u) - 0.5;
    float j4 = hash_f(hi, seed ^ 0x5u) - 0.5;
    float wa = P(P_PERF_W) + 0.016 * j2, hc = P(P_PERF_H) + 0.016 * j3;
    float r = clamp(P(P_PERF_R) + 0.08 * j4, 0.3, 0.6);
    float sc = ph + k * pitch + 0.5 * P(P_PERF_W) + 0.020 * j0;
    float tc = (top ? P(P_PERF_EDGE) + 0.5 * P(P_PERF_H) : W - P(P_PERF_EDGE) - 0.5 * P(P_PERF_H)) + 0.024 * j1;
    vec2 q = abs(vec2(st.x - sc, st.y - tc)) - vec2(0.5 * wa - r, 0.5 * hc - r);
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    // the punched edge: each hole's own roughness, 1-4 microns
    float rough = 0.001 + 0.003 * hash_f(hi, seed ^ 0x6u);
    d += rough * (value_noise(st.x / 0.05, seed ^ 0x77u) + value_noise(st.y / 0.05, seed ^ 0x99u) - 1.0) * 2.0;
    // a burr or a chip on about one hole in four
    if (hash_f(hi, seed ^ 0x7u) < 0.25) {
        float ang = 6.2831853 * hash_f(hi, seed ^ 0x8u);
        vec2 pb = vec2(sc, tc) + vec2(cos(ang) * 0.5 * wa, sin(ang) * 0.5 * hc);
        float sig = 0.020 + 0.030 * hash_f(hi, seed ^ 0x9u);
        float amp = (hash_f(hi, seed ^ 0xAu) < 0.5 ? -1.0 : 1.0) * (0.006 + 0.010 * hash_f(hi, seed ^ 0xBu));
        d += amp * exp(-dot(st - pb, st - pb) / (sig * sig));
    }
    return d;
}

// The measured softness of a perforation's edge in a scan (overscan.metal).
const float kHoleEdgeSigma = 0.017;

// erf, Abramowitz and Stegun 7.1.26 (|error| < 1.5e-7).
float erf_as(float x) {
    float t = 1.0 / (1.0 + 0.3275911 * abs(x));
    float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-x * x);
    return x < 0.0 ? -y : y;
}

// Where there is film: 1 on the strip, 0 in the perforations and past its edges.
float film_alpha(vec2 st) {
    float W = P(P_FILM_W), px = P(P_PX);
    float a = P(P_CARRIER) > 1.5 ? 1.0 : clamp(min(st.y, W - st.y) / px + 0.5, 0.0, 1.0);
    if (P(P_PERFORATED) > 0.5) {
        uint hole;
        float sigma = sqrt(kHoleEdgeSigma * kHoleEdgeSigma + 0.0961 * px * px);
        a *= 0.5 + 0.5 * erf_as(perf_sdf(st, hole) / (1.41421356 * sigma));
    }
    return a;
}
