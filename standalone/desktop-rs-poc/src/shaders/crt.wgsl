// Pi Code Desktop POC — CRT screen material.
//
// Fragment shader run on the fullscreen quad that shows the UI render target.
// Handles the WHOLE CRT stack in one pass, so we can layer effects in the
// exact order a real tube would and pick coordinate spaces per effect.
//
//   1. Barrel warp (pure radial, aspect-corrected, C1-continuous everywhere)
//      — we use our own formula because Bevy's built-in LensDistortion uses
//      `adjust = dot(abs(direction), multiplier)` which is C1-discontinuous
//      on the horizontal/vertical axes and produces visible kinks in any UI
//      border line that crosses those axes.
//   2. Sample the UI texture at the warped UV; out-of-bounds → black
//      (no edge-clamp bleed, no "lines to infinity" artifact).
//   3. Phosphor bleed — cheap 4-tap cross soft-glow around neighbours.
//   4. Scanlines, sweep line — driven by the WARPED y so they follow the
//      tube curvature automatically (curved scanlines for free).
//   5. Noise, flicker — screen-space so the grain doesn't warp.
//   6. Bezel fade — squircle Lp-norm distance from center, faded in the
//      outer margin. This is the physical glass rim of the tube. Applied
//      last so every additive effect (sweep, noise) also darkens at the
//      edge, and there is no hard mesh/background transition.

#import bevy_sprite::mesh2d_vertex_output::VertexOutput

struct CrtParams {
    time: f32,
    scanline_density: f32,
    scanline_intensity: f32,
    sweep_speed: f32,
    sweep_intensity: f32,
    sweep_width: f32,
    noise_intensity: f32,
    phosphor_bleed: f32,
    flicker_intensity: f32,
    barrel_intensity: f32,
    barrel_scale: f32,
    barrel_edge_curvature: f32,
    bezel_softness: f32,
    bezel_shape: f32,
    bloom_intensity: f32,
    bloom_radius: f32,
};

@group(2) @binding(0) var ui_texture: texture_2d<f32>;
@group(2) @binding(1) var ui_sampler: sampler;
@group(2) @binding(2) var<uniform> params: CrtParams;

fn hash21(p: vec2<f32>) -> f32 {
    let h = dot(p, vec2<f32>(127.1, 311.7));
    return fract(sin(h) * 43758.5453123);
}

@fragment
fn fragment(in: VertexOutput) -> @location(0) vec4<f32> {
    let uv = in.uv;
    let dims = vec2<f32>(textureDimensions(ui_texture));
    let aspect = dims.x / dims.y;

    // === Barrel warp — pure radial, aspect-corrected ===
    // Aspect-correction: move into a space where a circle in (px, py) is
    // actually circular on screen, so the distortion is truly radial rather
    // than anamorphic. This is what removes the "kink on the axes" — the
    // whole formula is smooth in every direction.
    let uv_centered = uv - vec2<f32>(0.5, 0.5);
    let px = uv_centered.x * aspect;
    let py = uv_centered.y;
    let r2 = px * px + py * py;

    // Brown-Conrady-ish radial polynomial. `k2 = k1 * intensity * edge_curvature`
    // matches Bevy's own convention so that dropping barrel_intensity to zero
    // also zeroes the r⁴ term. Small edge_curvature values just gently pinch
    // the corners; large values would still make the polynomial non-monotonic
    // but you have to hit ~edge_curvature ≥ 4 with intensity ~0.5 for that
    // to show up, whereas Bevy's abs-direction variant shows kinks at any
    // setting.
    let k1 = params.barrel_intensity;
    let k2 = k1 * params.barrel_intensity * params.barrel_edge_curvature;
    let dist_factor = 1.0 + (k1 + k2 * r2) * r2;

    // Distortion pushes the sample OUTWARD from centre; scale > 1 pulls the
    // whole thing back inside 0..1 so we don't sample past the UI texture.
    let px_d = px * dist_factor;
    let py_d = py * dist_factor;
    let scale = max(params.barrel_scale, 0.001);
    let uv_sample = vec2<f32>(px_d / aspect, py_d) / scale + vec2<f32>(0.5, 0.5);

    // === Sample UI (black outside texture, no edge-clamp bleed) ===
    var color: vec4<f32>;
    let in_bounds = uv_sample.x >= 0.0 && uv_sample.x <= 1.0
                 && uv_sample.y >= 0.0 && uv_sample.y <= 1.0;
    if (in_bounds) {
        color = textureSample(ui_texture, ui_sampler, uv_sample);

        // Phosphor bleed — 4-tap cross at 1.5px, character-fringe scale.
        if (params.phosphor_bleed > 0.0) {
            let step = 1.5 / dims;
            var bleed = vec3<f32>(0.0);
            bleed = bleed + textureSample(ui_texture, ui_sampler, uv_sample + vec2<f32>( step.x, 0.0)).rgb;
            bleed = bleed + textureSample(ui_texture, ui_sampler, uv_sample + vec2<f32>(-step.x, 0.0)).rgb;
            bleed = bleed + textureSample(ui_texture, ui_sampler, uv_sample + vec2<f32>(0.0,  step.y)).rgb;
            bleed = bleed + textureSample(ui_texture, ui_sampler, uv_sample + vec2<f32>(0.0, -step.y)).rgb;
            color = vec4<f32>(color.rgb + bleed * 0.25 * params.phosphor_bleed, color.a);
        }

        // Bloom — glyph-level glow via two rings of 8 taps each. Approximates
        // a Gaussian without ping-pong render targets. Because black pixels
        // contribute zero to an additive sum, the halo only appears around
        // bright content (text, borders) — no threshold or bright-pass
        // needed. Total cost: 16 additional texture samples per fragment.
        if (params.bloom_intensity > 0.0) {
            let base = max(params.bloom_radius, 0.001) / dims;
            var bloom = vec3<f32>(0.0);
            // Inner ring — 8 taps at 1× base radius, full weight.
            for (var i = 0u; i < 8u; i = i + 1u) {
                let a = f32(i) * 0.78539816;
                let offs = vec2<f32>(cos(a), sin(a)) * base;
                bloom = bloom + textureSample(ui_texture, ui_sampler, uv_sample + offs).rgb;
            }
            // Outer ring — 8 taps at 2.5× radius, half weight, phase-shifted.
            for (var i = 0u; i < 8u; i = i + 1u) {
                let a = f32(i) * 0.78539816 + 0.39269908;
                let offs = vec2<f32>(cos(a), sin(a)) * base * 2.5;
                bloom = bloom + 0.5 * textureSample(ui_texture, ui_sampler, uv_sample + offs).rgb;
            }
            // Weight sum = 8*1 + 8*0.5 = 12.
            bloom = bloom / 12.0;
            color = vec4<f32>(color.rgb + bloom * params.bloom_intensity, color.a);
        }
    } else {
        color = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    // === Scanlines (driven by warped Y → curved with the tube) ===
    let line_phase = uv_sample.y * max(params.scanline_density, 1.0);
    let scanline = 0.5 + 0.5 * cos(line_phase * 6.283185307);
    let scanline_factor = 1.0 - params.scanline_intensity * (1.0 - scanline);
    color = vec4<f32>(color.rgb * scanline_factor, color.a);

    // === Sweep line (also driven by warped Y) ===
    if (params.sweep_intensity > 0.0) {
        let sweep_pos = fract(params.time * params.sweep_speed);
        let sweep_dist = abs(uv_sample.y - sweep_pos);
        let width = max(params.sweep_width, 0.001);
        let sweep = exp(-sweep_dist * sweep_dist / (width * width));
        let sweep_color = vec3<f32>(0.847, 1.0, 0.361) * sweep * params.sweep_intensity;
        color = vec4<f32>(color.rgb + sweep_color, color.a);
    }

    // === Noise (screen-space so grain stays crisp; doesn't warp) ===
    if (params.noise_intensity > 0.0) {
        let n = hash21(floor(uv * dims * 0.5) + vec2<f32>(params.time * 60.0, params.time * 47.0));
        let n_signed = (n - 0.5) * 2.0;
        color = vec4<f32>(color.rgb + vec3<f32>(n_signed) * params.noise_intensity, color.a);
    }

    // === Flicker ===
    if (params.flicker_intensity > 0.0) {
        let f = sin(params.time * 60.0) * 0.5 + cos(params.time * 37.0) * 0.3;
        color = vec4<f32>(color.rgb * (1.0 + f * params.flicker_intensity * 0.02), color.a);
    }

    // === Bezel fade — squircle Lp-norm distance from centre ===
    // shape = 2  → pure ellipse (aspect-scaled), 6 → rounded rectangle
    // similar to a real CRT tube, 20+ → nearly rectangular window.
    // The fade band width is controlled by `bezel_softness` and sits centred
    // on the squircle=1.0 contour (which touches the corners of the mesh in
    // shape 2, or bulges outside in higher shapes).
    let nx = abs(uv.x - 0.5) * 2.0;
    let ny = abs(uv.y - 0.5) * 2.0;
    let shape = max(params.bezel_shape, 1.0);
    let sq_dist = pow(pow(nx, shape) + pow(ny, shape), 1.0 / shape);
    let softness = max(params.bezel_softness, 0.001);
    let bezel_alpha = 1.0 - smoothstep(1.0 - softness, 1.0 + softness, sq_dist);
    color = vec4<f32>(color.rgb * bezel_alpha, color.a);

    return color;
}
