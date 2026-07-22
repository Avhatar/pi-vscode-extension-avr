// Bevy POC — Day 3.
// Live composer via Bevy 0.19's `EditableText` widget (native TextInput with IME,
// blinking cursor, clipboard, etc.). Feed becomes a Resource; a system observes
// its `Changed` flag and rebuilds the feed UI. Enter is caught by a keyboard
// system that submits the composer text, adds a fake PI echo, and clears the
// input. Toggle visual bug from Day 2 is fixed (outer background wired
// correctly, inner slider moves via alignment).

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use bevy::asset::{Asset, embedded_asset};
use bevy::camera::RenderTarget;
use bevy::image::ImageSampler;
use bevy::input::ButtonState;
use bevy::input::keyboard::KeyboardInput;
use bevy::input_focus::AutoFocus;
use bevy::math::primitives::Rectangle;
use bevy::post_process::effect_stack::{ChromaticAberration, Vignette};
use bevy::prelude::*;
use bevy::reflect::TypePath;
use bevy::render::render_resource::{
    AsBindGroup, Extent3d, ShaderType, TextureDescriptor, TextureDimension, TextureFormat,
    TextureUsages,
};
use bevy::shader::ShaderRef;
use bevy::sprite_render::{Material2d, Material2dPlugin, MeshMaterial2d};
use bevy::text::{EditableText, FontSize, FontSource, TextCursorStyle};
use bevy::ui::{
    BackgroundGradient, ColorStop, Gradient, RadialGradient, RadialGradientShape, UiPosition,
    UiTargetCamera,
};
use bevy::window::WindowResolution;
use serde::{Deserialize, Serialize};

// -- Palette -----------------------------------------------------------------
const PHOSPHOR: Color = Color::srgb(0.847, 1.0, 0.361); // #d8ff5c
const INK: Color = Color::srgb(0.016, 0.062, 0.043); // #04100b
const BG_APP: Color = Color::srgb(0.023, 0.051, 0.043); // #060d0b
const FAILED: Color = Color::srgb(1.0, 0.416, 0.333); // #ff6a55

fn phos_alpha(a: f32) -> Color {
    PHOSPHOR.with_alpha(a)
}

// -- Layout constants --------------------------------------------------------
const RAIL_WIDTH: f32 = 64.0;
const PANEL_WIDTH: f32 = 340.0;
const RAIL_BUTTON_SIZE: f32 = 48.0;
const RAIL_BUTTON_SMALL: f32 = 38.0;

// -- Font resource -----------------------------------------------------------
#[derive(Resource, Clone)]
struct TerminalFont(Handle<Font>);

// -- Feed model --------------------------------------------------------------
#[derive(Copy, Clone)]
enum RowKind {
    User,
    Normal,
    Error,
}

#[derive(Clone)]
struct FeedRow {
    who: String,
    content: String,
    kind: RowKind,
}

#[derive(Resource, Default)]
struct FeedState {
    rows: Vec<FeedRow>,
}

// -- Marker components -------------------------------------------------------
#[derive(Component)]
struct FeedContainer;

#[derive(Component)]
struct ComposerInput;

#[derive(Component)]
struct CrtCamera;

#[derive(Component)]
struct UiRenderCamera;

/// Marker for the full-window overlay Node that carries the radial vignette
/// gradient. Living inside the UI tree means the vignette is captured to
/// `ui_target_handle` and then barrel-warped by the main camera, so the fade
/// naturally curves to follow the tube shape rather than staying circular.
#[derive(Component)]
struct TubeVignette;

// -- Runtime-tweakable settings ---------------------------------------------
// Values live in `config/poc.toml` next to the crate. The `poll_settings_file`
// system checks mtime every frame and reloads on change; any system that reads
// `Res<PocSettings>` sees the update via change detection. Extend the struct by
// adding a field with `#[serde(default = "...")]` so old files stay valid.

#[derive(Resource, Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
struct PocSettings {
    /// Composer block cursor blink period in milliseconds.
    cursor_blink_ms: u64,
    /// CRT barrel-warp strength. 0.0 = flat, 0.3 = subtle bulge,
    /// 0.5 = default Bevy (obvious), 0.8 = fisheye.
    barrel_intensity: f32,
    /// Zoom applied to compensate for barrel-warp cropping the edges.
    /// Bevy's LensDistortion shader clamps out-of-bounds UVs to the texture
    /// edge, so with `scale = 1.0` any warped sample that lands past the
    /// texture border shows the edge pixel repeated — this is what makes
    /// long horizontal/vertical UI border lines appear to "extend to
    /// infinity" along the top/bottom/left/right of the screen. Set to
    /// ~1.1 to leave a safety margin around `barrel_intensity ~ 0.2`.
    barrel_scale: f32,
    /// Weight of the quartic (r⁴) term in the barrel polynomial. Bevy
    /// default is 0.0 (pure r² curvature — the classic CRT tube shape).
    /// Positive values pinch corners harder than midpoints. Sane range
    /// 0.0–0.5. Above ~1.0 the polynomial derivative can flip sign, which
    /// produces visible KINKS in warped straight UI borders — a curved
    /// line bends one way then the other with a hard angle at the
    /// inflection point. If you see a corner-shaped artifact in a border
    /// that should be a smooth arc, this is the knob to lower.
    barrel_edge_curvature: f32,
    /// Chromatic aberration R/G/B split as fraction of window size.
    /// 0.0 = off, 0.01 = subtle, 0.03 = strong VHS look.
    chromatic_intensity: f32,
    /// Vignette darkness at the corners. 0.0 = none, 1.0 = fully black.
    /// This is the built-in Bevy Vignette that runs *after* barrel warp and
    /// stays circular in screen space. Keep at 0 to rely purely on the
    /// tube-shape vignette below, or blend both.
    vignette_intensity: f32,
    /// Radius of the un-vignetted centre area of the built-in vignette.
    /// 0.5 = tight halo, 0.75 = default Bevy, 1.0 = wide.
    vignette_radius: f32,
    /// Softness of the built-in vignette edge. 0.3 = hard, 5.0 = default Bevy.
    vignette_smoothness: f32,
    /// Tube-shape vignette: fraction of the ellipse radius that stays fully
    /// clear before the fade begins. 0.5 = fade starts halfway out, 0.8 =
    /// only the very edge fades. Because this vignette lives inside the UI
    /// capture, barrel warp bends it into the CRT-tube profile automatically.
    tube_center_extent: f32,
    /// Tube-shape vignette darkness at the outermost stop. 0.0 = off,
    /// 1.0 = fully opaque black past the ellipse.
    tube_edge_darkness: f32,
    /// Horizontal extent of the vignette ellipse as % of window width. 50 =
    /// touches left/right edges. 65 = smaller ellipse, corners fully black.
    /// 120 = ellipse extends past the window, no visible fade on the sides.
    tube_extent_x: f32,
    /// Vertical extent as % of window height. Same interpretation as
    /// tube_extent_x. Different X and Y let you shape the ellipse to match
    /// the aspect of your CRT tube.
    tube_extent_y: f32,
    /// Number of scanlines top-to-bottom across the viewport. 200 = ~4 px per
    /// line at 820 px height (feels like CRT). 400 = fine, 100 = coarse
    /// arcade look, 0 = off (the shader also short-circuits at intensity 0).
    scanline_density: f32,
    /// How dark the trough of the scanline is. 0.0 = invisible, 0.15 =
    /// terminal-subtle, 0.4 = aggressive arcade, 1.0 = fully black between
    /// lines (basically raster-line demo mode).
    scanline_intensity: f32,
    /// Sweep-line speed. Multiplied against time inside `fract(...)`, so this
    /// is the frequency in Hz. 0.15 = one full top-to-bottom pass every ~6.7 s.
    sweep_speed: f32,
    /// Peak added brightness of the sweep band. 0.0 = off, 0.1 = subtle,
    /// 0.4 = obvious phosphor pulse.
    sweep_intensity: f32,
    /// Gaussian standard deviation of the sweep band in UV units (0–1 across
    /// the height). 0.02 = razor-thin, 0.08 = wide soft band, 0.2 = whole-screen
    /// wash.
    sweep_width: f32,
    /// Per-pixel animated noise amplitude. 0.0 = off, 0.02 = TV static hint,
    /// 0.1 = heavy grain that starts to obscure text.
    noise_intensity: f32,
    /// Phosphor bleed — how strongly neighbour pixels leak into the current
    /// one. 0.0 = crisp, 0.3 = soft phosphor, 1.0 = smeary. Cheap 4-tap cross,
    /// not a real bloom.
    phosphor_bleed: f32,
    /// AC-hum flicker amplitude. Whole-screen brightness wobble via
    /// mixed-frequency sines. 0.0 = off, 0.5 = subtle, 2.0 = obvious pulse.
    flicker_intensity: f32,
    /// Width of the bezel fade band in normalized-squircle units. The band
    /// is centred on the squircle=1.0 contour, so `bezel_softness = 0.1`
    /// fades from 0.9 to 1.1. 0.0 → hard edge (no fade), 0.3 → very soft
    /// glass rim. Governs how the CRT tube blends into the surrounding
    /// black — you want this large enough that the mesh boundary is
    /// invisible.
    bezel_softness: f32,
    /// Lp-norm exponent for the bezel shape. 2.0 = pure ellipse
    /// (aspect-scaled), 6.0 = rounded rectangle (approximates a real CRT
    /// front glass), 20+ = near-rectangular window. Higher values move the
    /// tube corners closer to the actual mesh corners.
    bezel_shape: f32,
    /// Glyph-level phosphor glow around bright pixels. 16-tap ring gather
    /// approximating a Gaussian. 0.0 = off, 0.3 = terminal warmth, 0.8 =
    /// obvious halo, 1.5+ = saturated bright zones. Costs ~16 extra texture
    /// samples per fragment — cheap on modern GPUs.
    bloom_intensity: f32,
    /// Bloom base radius in pixels. Inner ring taps at this distance, outer
    /// ring at 2.5×. 3 = tight text halo, 6 = classic CRT bloom, 12+ = heavy
    /// diffusion (readability drops).
    bloom_radius: f32,
}

impl Default for PocSettings {
    fn default() -> Self {
        Self {
            cursor_blink_ms: 500,
            // Values tuned for a subtle CRT look — enough to sell the tube feel
            // without turning the screen into a fisheye.
            barrel_intensity: 0.18,
            barrel_scale: 1.15,
            barrel_edge_curvature: 0.1,
            chromatic_intensity: 0.008,
            // Built-in circular vignette off by default — the tube-shape
            // overlay below covers the same visual need.
            vignette_intensity: 0.0,
            vignette_radius: 0.65,
            vignette_smoothness: 0.5,
            // Flat centre out to ~60% of the radius, then hard fade to full
            // black. Combined with barrel warp this reads as a CRT tube.
            tube_center_extent: 0.6,
            tube_edge_darkness: 1.0,
            tube_extent_x: 65.0,
            tube_extent_y: 70.0,
            // CRT effect defaults — read as a working terminal at rest.
            scanline_density: 200.0,
            scanline_intensity: 0.18,
            sweep_speed: 0.15,
            sweep_intensity: 0.12,
            sweep_width: 0.06,
            noise_intensity: 0.025,
            phosphor_bleed: 0.35,
            flicker_intensity: 0.6,
            // Soft rounded-rectangle bezel that blends the tube into the
            // surrounding black. Shape 6 approximates a Trinitron / classic
            // arcade CRT front glass.
            bezel_softness: 0.15,
            bezel_shape: 6.0,
            // Subtle text halo — enough to feel like phosphor glow without
            // making the type mushy.
            bloom_intensity: 0.4,
            bloom_radius: 5.0,
        }
    }
}

#[derive(Resource, Default)]
struct SettingsFile {
    path: PathBuf,
    last_modified: Option<SystemTime>,
}

// -- Custom CRT screen material ---------------------------------------------
// A `Material2d` on the fullscreen quad that displays the UI capture. The
// fragment shader (embedded from `src/shaders/crt.wgsl`) samples the UI
// texture, layers scanlines, sweep, noise, phosphor bleed and flicker on top,
// then hands the result to the main camera's post-process stack (barrel warp,
// chromatic aberration, vignette). Curving happens after this material runs,
// so the scanlines bend to follow the tube for free.
//
// Layout matches the WGSL struct exactly. WGSL `struct` fields are packed
// per std140-like rules — trailing padding keeps the whole thing 16-byte
// aligned across every platform's uniform buffer requirements.

#[derive(ShaderType, Clone, Copy, Debug, Default)]
struct CrtShaderParams {
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
}

#[derive(Asset, AsBindGroup, TypePath, Clone)]
struct CrtScreenMaterial {
    #[texture(0)]
    #[sampler(1)]
    ui_texture: Handle<Image>,
    #[uniform(2)]
    params: CrtShaderParams,
}

impl Material2d for CrtScreenMaterial {
    fn fragment_shader() -> ShaderRef {
        // `embedded_asset!` in `CrtMaterialPlugin::build` registers this
        // path; the crate name uses underscores in the URL.
        "embedded://pi_code_desktop_poc/shaders/crt.wgsl".into()
    }
}

struct CrtMaterialPlugin;

impl Plugin for CrtMaterialPlugin {
    fn build(&self, app: &mut App) {
        // Ship the shader source inside the binary rather than reading it from
        // a file at runtime — keeps `cargo run` self-contained and doesn't
        // require polluting the private assets submodule with code.
        embedded_asset!(app, "shaders/crt.wgsl");
        app.add_plugins(Material2dPlugin::<CrtScreenMaterial>::default());
    }
}

/// Marker for the fullscreen mesh entity that carries the CRT material, so
/// the update system can find the material handle without querying every
/// `Mesh2d` in the world.
#[derive(Component)]
struct CrtScreenMesh;

fn main() {
    App::new()
        .add_plugins(DefaultPlugins.set(WindowPlugin {
            primary_window: Some(Window {
                title: "Pi Code Desktop POC".into(),
                resolution: WindowResolution::new(1280, 820),
                ..default()
            }),
            ..default()
        }))
        .add_plugins(CrtMaterialPlugin)
        .insert_resource(ClearColor(INK))
        .insert_resource(FeedState {
            rows: initial_feed(),
        })
        .add_systems(Startup, (setup, load_settings_at_startup))
        .add_systems(
            Update,
            (
                submit_on_enter,
                rebuild_feed_ui,
                poll_settings_file,
                apply_settings_to_composer,
                apply_settings_to_camera,
                apply_settings_to_tube_vignette,
                update_crt_material,
            ),
        )
        .run();
}

fn setup(
    mut commands: Commands,
    mut fonts: ResMut<Assets<Font>>,
    mut images: ResMut<Assets<Image>>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut crt_materials: ResMut<Assets<CrtScreenMaterial>>,
) {
    // -- Render-to-texture pipeline --
    // Bevy 0.19 runs UI *after* Core2d post-process (see bevy_ui_render:267),
    // so LensDistortion / ChromaticAberration / Vignette attached directly to a
    // Camera2d rendering UI would have no visible effect. Workaround: render
    // the whole UI into an offscreen texture with a first camera, then a second
    // camera displays that texture as a Sprite with the post-process stack
    // attached. Post-process sees the sprite pixels = the whole UI = warped.

    let target_size = Extent3d {
        width: 1280,
        height: 820,
        depth_or_array_layers: 1,
    };
    let mut ui_target = Image {
        texture_descriptor: TextureDescriptor {
            label: Some("ui-render-target"),
            size: target_size,
            dimension: TextureDimension::D2,
            // 16-bit float per channel. Eliminates the 8-bit alpha banding
            // that shows up on the tube-vignette gradient with an sRGB target,
            // and gives more headroom for future bloom/phosphor bleed passes.
            format: TextureFormat::Rgba16Float,
            mip_level_count: 1,
            sample_count: 1,
            usage: TextureUsages::TEXTURE_BINDING
                | TextureUsages::COPY_DST
                | TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        },
        sampler: ImageSampler::linear(),
        ..default()
    };
    ui_target.resize(target_size);
    let ui_target_handle = images.add(ui_target);

    // UI camera: renders every UI Node into `ui_target_handle`. Runs first (order -1).
    // In Bevy 0.19 RenderTarget moved out of Camera into its own component.
    let ui_camera = commands
        .spawn((
            Camera2d,
            Camera {
                order: -1,
                clear_color: ClearColorConfig::Custom(INK),
                ..default()
            },
            RenderTarget::Image(ui_target_handle.clone().into()),
            UiRenderCamera,
        ))
        .id();

    // Main camera: renders a fullscreen mesh with the custom CRT material,
    // then Bevy's post-process stack (ChromaticAberration, Vignette) runs on
    // this camera's output. Barrel warp is NOT here — we do it inside the
    // CRT shader instead, because Bevy's LensDistortion uses an
    // anisotropic `dot(abs(direction), multiplier)` formulation that is
    // C1-discontinuous on the horizontal/vertical axes and produces visible
    // kinks in any UI border line that crosses them.
    //
    // Clear color is pure BLACK so any pixel not covered by the mesh (should
    // be none — mesh is 1:1 with viewport) reads as clean background. The
    // shader's bezel fade takes care of a soft roll-off at the mesh edges.
    commands.spawn((
        Camera2d,
        Camera {
            order: 0,
            clear_color: ClearColorConfig::Custom(Color::BLACK),
            ..default()
        },
        CrtCamera,
        ChromaticAberration::default(),
        Vignette::default(),
    ));

    // Fullscreen quad textured with the UI capture, but rendered through the
    // custom CRT `Material2d` instead of a plain `Sprite`. The shader samples
    // the UI texture, layers scanlines / sweep / noise / phosphor bleed on
    // top, then hands its output to the main camera's post-process stack.
    // Barrel warp bends everything (including the scanlines) into the CRT
    // tube profile automatically.
    //
    // Rectangle mesh is centred at (0,0) with size 1280×820; Bevy's default
    // Camera2d ortho projection is 1 world unit = 1 pixel, so this exactly
    // fills the viewport without any Transform scaling gymnastics.
    commands.spawn((
        Mesh2d(meshes.add(Rectangle::new(1280.0, 820.0))),
        MeshMaterial2d(crt_materials.add(CrtScreenMaterial {
            ui_texture: ui_target_handle,
            params: CrtShaderParams::default(),
        })),
        Transform::from_xyz(0.0, 0.0, 0.0),
        CrtScreenMesh,
    ));

    let font = load_monofonto(&mut fonts);
    commands.insert_resource(TerminalFont(font.clone()));

    commands
        .spawn((
            Node {
                width: Val::Percent(100.0),
                height: Val::Percent(100.0),
                flex_direction: FlexDirection::Row,
                ..default()
            },
            BackgroundColor(INK),
            // Route the whole UI tree to the offscreen UI camera. Children
            // inherit UiTargetCamera through the propagation plugin.
            UiTargetCamera(ui_camera),
        ))
        .with_children(|root| {
            build_icon_rail(root, &font);
            build_control_panel(root, &font);
            build_main_column(root, &font);
            build_tube_vignette(root);
        });
}

/// Full-window absolute-positioned Node that layers a radial gradient over the
/// interface. Placed at the end of the tree so it renders on top, but with no
/// Interaction component so mouse events pass through to the widgets beneath.
/// Because it belongs to the UI capture, the main camera's barrel warp bends
/// this ellipse into the CRT-tube fade the user asked for.
fn build_tube_vignette(parent: &mut ChildSpawnerCommands) {
    parent.spawn((
        Node {
            position_type: PositionType::Absolute,
            left: Val::Px(0.0),
            top: Val::Px(0.0),
            width: Val::Percent(100.0),
            height: Val::Percent(100.0),
            ..default()
        },
        BackgroundGradient(vec![Gradient::Radial(RadialGradient {
            position: UiPosition::CENTER,
            // Overwritten by `apply_settings_to_tube_vignette` from PocSettings
            // — Ellipse lets us push the 100% stop past the screen if desired.
            shape: RadialGradientShape::Ellipse(Val::Percent(65.0), Val::Percent(70.0)),
            stops: initial_tube_stops(),
            ..default()
        })]),
        TubeVignette,
    ));
}

fn initial_tube_stops() -> Vec<ColorStop> {
    // Overwritten each time PocSettings changes; this is just the seed so the
    // component is well-formed on spawn.
    vec![
        ColorStop::new(Color::srgba(0.0, 0.0, 0.0, 0.0), Val::Percent(0.0)),
        ColorStop::new(Color::srgba(0.0, 0.0, 0.0, 0.0), Val::Percent(60.0)),
        ColorStop::new(Color::srgba(0.0, 0.0, 0.0, 1.0), Val::Percent(100.0)),
    ]
}

// -- Icon rail ---------------------------------------------------------------
fn build_icon_rail(parent: &mut ChildSpawnerCommands, font: &Handle<Font>) {
    parent
        .spawn((
            Node {
                width: Val::Px(RAIL_WIDTH),
                height: Val::Percent(100.0),
                flex_direction: FlexDirection::Column,
                padding: UiRect::vertical(Val::Px(16.0)),
                row_gap: Val::Px(14.0),
                align_items: AlignItems::Center,
                border: UiRect::right(Val::Px(2.0)),
                ..default()
            },
            BackgroundColor(BG_APP),
            BorderColor::all(phos_alpha(0.30)),
        ))
        .with_children(|rail| {
            rail_button(rail, font, "+", false);
            rail_button(rail, font, "◀", false);
            rail.spawn(Node {
                flex_grow: 1.0,
                ..default()
            });
            rail_button(rail, font, "⊞", true);
            rail_button(rail, font, "M", true);
        });
}

fn rail_button(parent: &mut ChildSpawnerCommands, font: &Handle<Font>, glyph: &str, small: bool) {
    let size = if small {
        RAIL_BUTTON_SMALL
    } else {
        RAIL_BUTTON_SIZE
    };
    let font_size = if small { 20.0 } else { 27.0 };
    parent
        .spawn((
            Node {
                width: Val::Px(RAIL_BUTTON_SIZE),
                height: Val::Px(size),
                justify_content: JustifyContent::Center,
                align_items: AlignItems::Center,
                border: UiRect::all(Val::Px(2.0)),
                ..default()
            },
            BackgroundColor(phos_alpha(0.12)),
            BorderColor::all(PHOSPHOR),
        ))
        .with_children(|btn| {
            btn.spawn((
                Text::new(glyph),
                TextFont {
                    font: FontSource::Handle(font.clone()),
                    font_size: FontSize::Px(font_size),
                    ..default()
                },
                TextColor(PHOSPHOR),
            ));
        });
}

// -- Control panel -----------------------------------------------------------
fn build_control_panel(parent: &mut ChildSpawnerCommands, font: &Handle<Font>) {
    parent
        .spawn((
            Node {
                width: Val::Px(PANEL_WIDTH),
                height: Val::Percent(100.0),
                flex_direction: FlexDirection::Column,
                padding: UiRect::all(Val::Px(18.0)),
                row_gap: Val::Px(6.0),
                border: UiRect::right(Val::Px(1.0)),
                ..default()
            },
            BackgroundColor(BG_APP),
            BorderColor::all(phos_alpha(0.16)),
        ))
        .with_children(|panel| {
            panel
                .spawn(Node {
                    flex_direction: FlexDirection::Row,
                    justify_content: JustifyContent::SpaceBetween,
                    align_items: AlignItems::Center,
                    column_gap: Val::Px(8.0),
                    ..default()
                })
                .with_children(|row| {
                    row.spawn((
                        Text::new("PI CODE"),
                        text_font(font, 15.0),
                        TextColor(phos_alpha(0.65)),
                    ));
                    row.spawn((
                        Node {
                            width: Val::Px(48.0),
                            height: Val::Px(18.0),
                            justify_content: JustifyContent::Center,
                            align_items: AlignItems::Center,
                            border: UiRect::all(Val::Px(1.0)),
                            ..default()
                        },
                        BackgroundColor(Color::NONE),
                        BorderColor::all(PHOSPHOR),
                    ))
                    .with_children(|badge| {
                        badge.spawn((
                            Text::new("LINK"),
                            text_font(font, 12.0),
                            TextColor(PHOSPHOR),
                        ));
                    });
                });

            panel.spawn((
                Text::new("NO WORKSPACE"),
                text_font(font, 14.0),
                TextColor(phos_alpha(0.45)),
            ));

            spacer(panel, 6.0);

            toggle_row(panel, font, "PLAN MODE", false);
            hairline(panel);
            toggle_row(panel, font, "FILE UNDO VIEW", false);
            hairline(panel);

            section_header(panel, font, "NOTIFICATIONS", "");
            section_header(panel, font, "TODO", "0/0");
            section_header(panel, font, "SUBAGENTS", "0");
            section_header(panel, font, "HISTORY", "—");
            section_header(panel, font, "TOOLS", "0/0");
        });
}

fn toggle_row(parent: &mut ChildSpawnerCommands, font: &Handle<Font>, label: &str, on: bool) {
    parent
        .spawn(Node {
            flex_direction: FlexDirection::Row,
            justify_content: JustifyContent::SpaceBetween,
            align_items: AlignItems::Center,
            height: Val::Px(34.0),
            padding: UiRect::horizontal(Val::Px(4.0)).with_left(Val::Px(10.0)),
            column_gap: Val::Px(10.0),
            ..default()
        })
        .with_children(|row| {
            row.spawn((
                Text::new(label),
                text_font(font, 15.0),
                TextColor(PHOSPHOR),
            ));
            // Track — hollow when off, filled phosphor when on. Slider inside.
            row.spawn((
                Node {
                    width: Val::Px(48.0),
                    height: Val::Px(22.0),
                    justify_content: if on {
                        JustifyContent::FlexEnd
                    } else {
                        JustifyContent::FlexStart
                    },
                    align_items: AlignItems::Center,
                    padding: UiRect::horizontal(Val::Px(3.0)),
                    border: UiRect::all(Val::Px(2.0)),
                    ..default()
                },
                BackgroundColor(if on { PHOSPHOR } else { Color::NONE }),
                BorderColor::all(PHOSPHOR),
            ))
            .with_children(|toggle| {
                toggle.spawn((
                    Node {
                        width: Val::Px(16.0),
                        height: Val::Px(12.0),
                        ..default()
                    },
                    BackgroundColor(if on { INK } else { PHOSPHOR }),
                ));
            });
        });
}

fn section_header(parent: &mut ChildSpawnerCommands, font: &Handle<Font>, title: &str, count: &str) {
    parent
        .spawn(Node {
            flex_direction: FlexDirection::Row,
            justify_content: JustifyContent::SpaceBetween,
            align_items: AlignItems::Center,
            height: Val::Px(30.0),
            padding: UiRect::horizontal(Val::Px(8.0)).with_left(Val::Px(3.0)),
            column_gap: Val::Px(8.0),
            ..default()
        })
        .with_children(|row| {
            row.spawn((
                Text::new(format!("▾ {title}")),
                text_font(font, 15.0),
                TextColor(PHOSPHOR),
            ));
            row.spawn((
                Text::new(count),
                text_font(font, 14.0),
                TextColor(phos_alpha(0.7)),
            ));
        });
}

// -- Main column -------------------------------------------------------------
fn build_main_column(parent: &mut ChildSpawnerCommands, font: &Handle<Font>) {
    parent
        .spawn((
            Node {
                flex_grow: 1.0,
                flex_direction: FlexDirection::Column,
                padding: UiRect::all(Val::Px(24.0)),
                row_gap: Val::Px(14.0),
                height: Val::Percent(100.0),
                ..default()
            },
            BackgroundColor(BG_APP),
        ))
        .with_children(|col| {
            col.spawn(Node {
                flex_direction: FlexDirection::Row,
                justify_content: JustifyContent::SpaceBetween,
                ..default()
            })
            .with_children(|hdr| {
                hdr.spawn((
                    Text::new("PI-CODE TERMLINK · AGENT HOST"),
                    text_font(font, 15.0),
                    TextColor(phos_alpha(0.55)),
                ));
                hdr.spawn((
                    Text::new("00:00:00"),
                    text_font(font, 15.0),
                    TextColor(phos_alpha(0.55)),
                ));
            });

            col.spawn((
                Node {
                    width: Val::Px(230.0),
                    height: Val::Px(30.0),
                    flex_direction: FlexDirection::Row,
                    justify_content: JustifyContent::SpaceBetween,
                    align_items: AlignItems::Center,
                    padding: UiRect::horizontal(Val::Px(8.0)).with_left(Val::Px(10.0)),
                    ..default()
                },
                BackgroundColor(PHOSPHOR),
            ))
            .with_children(|tab| {
                tab.spawn((
                    Text::new("▸ SESSION 01"),
                    text_font(font, 15.0),
                    TextColor(INK),
                ));
                tab.spawn((Text::new("×"), text_font(font, 17.0), TextColor(INK)));
            });

            hairline(col);

            col.spawn(Node {
                flex_direction: FlexDirection::Row,
                justify_content: JustifyContent::SpaceBetween,
                ..default()
            })
            .with_children(|row| {
                row.spawn((
                    Text::new("ACTIVE SESSION"),
                    text_font(font, 13.0),
                    TextColor(phos_alpha(0.4)),
                ));
                row.spawn((
                    Text::new("CONNECTING"),
                    text_font(font, 13.0),
                    TextColor(phos_alpha(0.4)),
                ));
            });

            // Feed — spawned empty here. Populated by `rebuild_feed_ui`
            // whenever FeedState changes (including the initial seed).
            col.spawn((
                Node {
                    flex_grow: 1.0,
                    flex_direction: FlexDirection::Column,
                    row_gap: Val::Px(7.0),
                    ..default()
                },
                FeedContainer,
            ));

            // Composer — live TextInput.
            col.spawn(Node {
                flex_direction: FlexDirection::Row,
                align_items: AlignItems::Center,
                column_gap: Val::Px(10.0),
                ..default()
            })
            .with_children(|row| {
                row.spawn((
                    Text::new(">"),
                    text_font(font, 22.0),
                    TextColor(phos_alpha(0.75)),
                ));
                // EditableText widget. Requires TextFont + TextColor (see the
                // `#[require(...)]` on the component). Focus is granted by
                // clicking; we also give it initial focus below.
                row.spawn((
                    Node {
                        flex_grow: 1.0,
                        height: Val::Px(28.0),
                        ..default()
                    },
                    // PIP-Boy / classic-terminal block cursor: `cursor_width` is a
                    // multiplier of font size (default 0.2 = thin caret line).
                    // 0.6 approximates the advance width of a Monofonto glyph so the
                    // block sits over a single character. Blink period is bumped
                    // to ~500ms — snappier than Bevy's 1s default.
                    EditableText {
                        cursor_width: 0.6,
                        cursor_blink_period: std::time::Duration::from_millis(500),
                        ..EditableText::default()
                    },
                    text_font(font, 20.0),
                    TextColor(PHOSPHOR),
                    // TextCursorStyle is optional — without it no cursor renders
                    // at all. Default color is slate grey which would vanish on
                    // our phosphor palette, so we pin it to the terminal
                    // foreground and invert the character under the block.
                    TextCursorStyle {
                        color: PHOSPHOR,
                        selection_color: phos_alpha(0.35),
                        unfocused_selection_color: phos_alpha(0.15),
                        selected_text_color: Some(INK),
                    },
                    ComposerInput,
                    // Focus the composer on startup so the block cursor is
                    // visible immediately and typing works without a click.
                    // Cursor rendering is gated on `Some(entity) == input_focus.get()`.
                    AutoFocus,
                ));
            });

            col.spawn(Node {
                flex_direction: FlexDirection::Row,
                align_items: AlignItems::Center,
                column_gap: Val::Px(16.0),
                ..default()
            })
            .with_children(|bar| {
                status_plate(bar, font, "MODEL: SONNET", 140.0);
                status_plate(bar, font, "THINKING: —", 140.0);
                status_plate(bar, font, "CACHE: —", 110.0);
                bar.spawn((
                    Text::new("READY"),
                    text_font(font, 14.0),
                    TextColor(phos_alpha(0.45)),
                ));
                bar.spawn(Node {
                    flex_grow: 1.0,
                    ..default()
                });
                bar.spawn((
                    Text::new("CONTEXT: 23%"),
                    text_font(font, 14.0),
                    TextColor(phos_alpha(0.4)),
                ));
                bar.spawn((
                    Node {
                        width: Val::Px(30.0),
                        height: Val::Px(30.0),
                        justify_content: JustifyContent::Center,
                        align_items: AlignItems::Center,
                        border: UiRect::all(Val::Px(2.0)),
                        ..default()
                    },
                    BackgroundColor(Color::NONE),
                    BorderColor::all(FAILED),
                ))
                .with_children(|btn| {
                    btn.spawn((Text::new("■"), text_font(font, 16.0), TextColor(FAILED)));
                });
            });
        });
}

// -- Feed rebuild system -----------------------------------------------------
fn rebuild_feed_ui(
    feed: Res<FeedState>,
    mut commands: Commands,
    font: Res<TerminalFont>,
    container: Query<Entity, With<FeedContainer>>,
) {
    if !feed.is_changed() {
        return;
    }
    let Ok(container_entity) = container.single() else {
        return;
    };
    commands.entity(container_entity).despawn_related::<Children>();
    commands.entity(container_entity).with_children(|parent| {
        for row in &feed.rows {
            terminal_row(parent, &font.0, &row.who, &row.content, row.kind);
        }
    });
}

fn terminal_row(
    parent: &mut ChildSpawnerCommands,
    font: &Handle<Font>,
    who: &str,
    content: &str,
    kind: RowKind,
) {
    let (color, opacity) = match kind {
        RowKind::User => (PHOSPHOR, 1.0),
        RowKind::Normal => (PHOSPHOR, 0.82),
        RowKind::Error => (FAILED, 1.0),
    };
    parent
        .spawn(Node {
            flex_direction: FlexDirection::Row,
            column_gap: Val::Px(14.0),
            padding: UiRect::horizontal(Val::Px(8.0))
                .with_top(Val::Px(3.0))
                .with_bottom(Val::Px(3.0)),
            align_items: AlignItems::FlexStart,
            ..default()
        })
        .with_children(|row| {
            row.spawn((
                Node {
                    width: Val::Px(56.0),
                    justify_content: JustifyContent::FlexEnd,
                    ..default()
                },
                children![(
                    Text::new(who.to_string()),
                    text_font(font, 16.0),
                    TextColor(color.with_alpha(0.5)),
                )],
            ));
            row.spawn((
                Node {
                    flex_grow: 1.0,
                    ..default()
                },
                children![(
                    Text::new(content.to_string()),
                    text_font(font, 19.0),
                    TextColor(color.with_alpha(opacity)),
                )],
            ));
        });
}

fn status_plate(parent: &mut ChildSpawnerCommands, font: &Handle<Font>, label: &str, width: f32) {
    parent
        .spawn((
            Node {
                width: Val::Px(width),
                height: Val::Px(30.0),
                justify_content: JustifyContent::Center,
                align_items: AlignItems::Center,
                border: UiRect::all(Val::Px(2.0)),
                ..default()
            },
            BackgroundColor(BG_APP),
            BorderColor::all(PHOSPHOR),
        ))
        .with_children(|plate| {
            plate.spawn((
                Text::new(label.to_string()),
                text_font(font, 14.0),
                TextColor(PHOSPHOR),
            ));
        });
}

// -- Settings hot-reload -----------------------------------------------------

fn settings_file_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("config/poc.toml")
}

fn load_settings_at_startup(mut commands: Commands) {
    let path = settings_file_path();
    let (settings, last_modified) = match std::fs::metadata(&path).and_then(|m| m.modified()) {
        Ok(mtime) => match std::fs::read_to_string(&path).and_then(|text| {
            toml::from_str::<PocSettings>(&text).map_err(std::io::Error::other)
        }) {
            Ok(s) => {
                info!("[poc] settings loaded from {}", path.display());
                (s, Some(mtime))
            }
            Err(err) => {
                warn!(
                    "[poc] settings parse failed at {}: {err}. Using defaults.",
                    path.display()
                );
                (PocSettings::default(), Some(mtime))
            }
        },
        Err(_) => {
            let defaults = PocSettings::default();
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            match toml::to_string(&defaults) {
                Ok(text) => {
                    if let Err(err) = std::fs::write(&path, text) {
                        warn!("[poc] could not write default settings to {}: {err}", path.display());
                    } else {
                        info!("[poc] wrote default settings to {}", path.display());
                    }
                }
                Err(err) => warn!("[poc] could not serialize default settings: {err}"),
            }
            let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
            (defaults, mtime)
        }
    };
    commands.insert_resource(settings);
    commands.insert_resource(SettingsFile {
        path,
        last_modified,
    });
}

fn poll_settings_file(mut file: ResMut<SettingsFile>, mut settings: ResMut<PocSettings>) {
    let Ok(mtime) = std::fs::metadata(&file.path).and_then(|m| m.modified()) else {
        return;
    };
    if Some(mtime) == file.last_modified {
        return;
    }
    match std::fs::read_to_string(&file.path) {
        Ok(text) => match toml::from_str::<PocSettings>(&text) {
            Ok(new_settings) => {
                *settings = new_settings;
                file.last_modified = Some(mtime);
                info!("[poc] settings reloaded from {}", file.path.display());
            }
            Err(err) => {
                warn!("[poc] settings reload — parse failed: {err}");
                // Update mtime anyway so we don't spam warnings every frame.
                file.last_modified = Some(mtime);
            }
        },
        Err(err) => {
            warn!("[poc] settings reload — read failed: {err}");
            file.last_modified = Some(mtime);
        }
    }
}

fn apply_settings_to_composer(
    settings: Res<PocSettings>,
    mut composer_query: Query<&mut EditableText, With<ComposerInput>>,
) {
    if !settings.is_changed() {
        return;
    }
    for mut composer in &mut composer_query {
        composer.cursor_blink_period = Duration::from_millis(settings.cursor_blink_ms);
    }
}

fn apply_settings_to_camera(
    settings: Res<PocSettings>,
    mut camera_query: Query<(&mut ChromaticAberration, &mut Vignette), With<CrtCamera>>,
) {
    if !settings.is_changed() {
        return;
    }
    for (mut chrom, mut vig) in &mut camera_query {
        chrom.intensity = settings.chromatic_intensity;
        vig.intensity = settings.vignette_intensity;
        vig.radius = settings.vignette_radius;
        vig.smoothness = settings.vignette_smoothness;
    }
}

/// Refresh the CRT shader uniforms. Runs every frame because `time` is one
/// of the inputs — the sweep and noise animate off it. Settings values are
/// copied unconditionally rather than gated by `Res<PocSettings>::is_changed`
/// so a mid-run TOML edit propagates on the very next tick without waiting
/// for the next parameter to change.
fn update_crt_material(
    time: Res<Time>,
    settings: Res<PocSettings>,
    mut materials: ResMut<Assets<CrtScreenMaterial>>,
    query: Query<&MeshMaterial2d<CrtScreenMaterial>, With<CrtScreenMesh>>,
) {
    for handle_wrapper in &query {
        if let Some(mut material) = materials.get_mut(&handle_wrapper.0) {
            material.params.time = time.elapsed_secs();
            material.params.scanline_density = settings.scanline_density.max(0.0);
            material.params.scanline_intensity = settings.scanline_intensity.clamp(0.0, 1.0);
            material.params.sweep_speed = settings.sweep_speed;
            material.params.sweep_intensity = settings.sweep_intensity.max(0.0);
            material.params.sweep_width = settings.sweep_width.max(0.0);
            material.params.noise_intensity = settings.noise_intensity.max(0.0);
            material.params.phosphor_bleed = settings.phosphor_bleed.max(0.0);
            material.params.flicker_intensity = settings.flicker_intensity.max(0.0);
            material.params.barrel_intensity = settings.barrel_intensity;
            material.params.barrel_scale = settings.barrel_scale.max(0.001);
            material.params.barrel_edge_curvature = settings.barrel_edge_curvature;
            material.params.bezel_softness = settings.bezel_softness.max(0.001);
            material.params.bezel_shape = settings.bezel_shape.max(1.0);
            material.params.bloom_intensity = settings.bloom_intensity.max(0.0);
            material.params.bloom_radius = settings.bloom_radius.max(0.001);
        }
    }
}

fn apply_settings_to_tube_vignette(
    settings: Res<PocSettings>,
    mut query: Query<&mut BackgroundGradient, With<TubeVignette>>,
) {
    if !settings.is_changed() {
        return;
    }
    let center_pct = (settings.tube_center_extent.clamp(0.0, 1.0)) * 100.0;
    let edge_alpha = settings.tube_edge_darkness.clamp(0.0, 1.0);
    let stops = vec![
        ColorStop::new(Color::srgba(0.0, 0.0, 0.0, 0.0), Val::Percent(0.0)),
        ColorStop::new(Color::srgba(0.0, 0.0, 0.0, 0.0), Val::Percent(center_pct)),
        ColorStop::new(
            Color::srgba(0.0, 0.0, 0.0, edge_alpha),
            Val::Percent(100.0),
        ),
    ];
    let shape = RadialGradientShape::Ellipse(
        Val::Percent(settings.tube_extent_x.max(1.0)),
        Val::Percent(settings.tube_extent_y.max(1.0)),
    );
    for mut bg in &mut query {
        if let Some(Gradient::Radial(radial)) = bg.0.first_mut() {
            radial.stops = stops.clone();
            radial.shape = shape.clone();
        }
    }
}

// -- Enter → submit ----------------------------------------------------------
fn submit_on_enter(
    mut keyboard: MessageReader<KeyboardInput>,
    mut composer_query: Query<&mut EditableText, With<ComposerInput>>,
    mut feed: ResMut<FeedState>,
) {
    let mut enter_pressed = false;
    for event in keyboard.read() {
        if event.state == ButtonState::Pressed
            && event.key_code == KeyCode::Enter
            && !event.repeat
        {
            enter_pressed = true;
        }
    }
    if !enter_pressed {
        return;
    }

    let Ok(mut composer) = composer_query.single_mut() else {
        return;
    };
    let text = composer.value().to_string();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }

    feed.rows.push(FeedRow {
        who: "USER".into(),
        content: trimmed.into(),
        kind: RowKind::User,
    });
    feed.rows.push(FeedRow {
        who: "PI".into(),
        content: format!("acknowledged: {trimmed}"),
        kind: RowKind::Normal,
    });

    // Clear the composer via a text edit so the PlainEditor stays consistent
    // with its cursor position tracking.
    composer.editor_mut().set_text("");
}

// -- Layout helpers ----------------------------------------------------------
fn text_font(font: &Handle<Font>, size: f32) -> TextFont {
    TextFont {
        font: FontSource::Handle(font.clone()),
        font_size: FontSize::Px(size),
        ..default()
    }
}

fn spacer(parent: &mut ChildSpawnerCommands, height_px: f32) {
    parent.spawn(Node {
        height: Val::Px(height_px),
        ..default()
    });
}

fn hairline(parent: &mut ChildSpawnerCommands) {
    parent.spawn((
        Node {
            height: Val::Px(1.0),
            width: Val::Percent(100.0),
            ..default()
        },
        BackgroundColor(phos_alpha(0.20)),
    ));
}

// -- Initial feed data -------------------------------------------------------
fn initial_feed() -> Vec<FeedRow> {
    let seed: &[(&str, &str, RowKind)] = &[
        ("USER", "how do i render curved scanlines in wgpu", RowKind::User),
        (
            "PI",
            "sample the source texture along a barrel-warped uv, then multiply by a sin(uv.y * lines) profile.",
            RowKind::Normal,
        ),
        ("TOOL", "read_file(dev-notes/poc-visual-proof.md) → 4231 bytes", RowKind::Normal),
        ("USER", "открой control panel и покажи todo", RowKind::User),
        (
            "PI",
            "control panel is on the left. todo section is currently empty (0/0).",
            RowKind::Normal,
        ),
        (
            "THINK",
            "considering whether to bundle node runtime prebuilt or require system install...",
            RowKind::Normal,
        ),
        ("DIFF", "src/main.rs +18 -2 (font registration via fontique)", RowKind::Normal),
        ("ERR", "connection failed: not implemented in POC", RowKind::Error),
    ];
    seed.iter()
        .map(|(who, content, kind)| FeedRow {
            who: (*who).into(),
            content: (*content).into(),
            kind: *kind,
        })
        .collect()
}

// -- Font loading ------------------------------------------------------------
fn load_monofonto(fonts: &mut ResMut<Assets<Font>>) -> Handle<Font> {
    let font_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("assets/fonts/monofonto/monofonto.otf");

    if !font_path.exists() {
        eprintln!(
            "[poc] Monofonto not found at {}.\n\
             Initialize the private submodule to enable the terminal typeface:\n  \
             git submodule update --init standalone/desktop-rs-poc/assets\n\
             Falling back to the Bevy default font.",
            font_path.display()
        );
        return Handle::default();
    }

    match std::fs::read(&font_path) {
        Ok(bytes) => fonts.add(Font::from_bytes(bytes)),
        Err(err) => {
            eprintln!("[poc] Failed to read Monofonto file: {err}");
            Handle::default()
        }
    }
}
