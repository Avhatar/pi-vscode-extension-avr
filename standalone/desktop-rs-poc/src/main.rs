// Bevy POC — Day 3.
// Live composer via Bevy 0.19's `EditableText` widget (native TextInput with IME,
// blinking cursor, clipboard, etc.). Feed becomes a Resource; a system observes
// its `Changed` flag and rebuilds the feed UI. Enter is caught by a keyboard
// system that submits the composer text, adds a fake PI echo, and clears the
// input. Toggle visual bug from Day 2 is fixed (outer background wired
// correctly, inner slider moves via alignment).

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use bevy::camera::RenderTarget;
use bevy::image::ImageSampler;
use bevy::input::ButtonState;
use bevy::input::keyboard::KeyboardInput;
use bevy::input_focus::AutoFocus;
use bevy::post_process::effect_stack::{ChromaticAberration, LensDistortion, Vignette};
use bevy::prelude::*;
use bevy::render::render_resource::{
    Extent3d, TextureDescriptor, TextureDimension, TextureFormat, TextureUsages,
};
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
    /// 1.0 = no zoom (visible black corners at high intensity),
    /// 1.15 = tight fit for barrel_intensity around 0.2.
    barrel_scale: f32,
    /// Extra curvature ramp at the very edges (0.0 = none, 0.5 = strong).
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
        }
    }
}

#[derive(Resource, Default)]
struct SettingsFile {
    path: PathBuf,
    last_modified: Option<SystemTime>,
}

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
            ),
        )
        .run();
}

fn setup(
    mut commands: Commands,
    mut fonts: ResMut<Assets<Font>>,
    mut images: ResMut<Assets<Image>>,
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

    // Main camera: renders a fullscreen Sprite showing the UI target, then the
    // post-process stack (barrel warp / chromatic / vignette) runs on this
    // camera's output. Order 0 = default, runs after UI camera.
    //
    // Clear color is pure BLACK so any pixel not covered by the sprite (e.g.
    // corner areas after barrel warp squeezes content inward) blends with the
    // vignette's fade-to-black without a visible transition seam.
    commands.spawn((
        Camera2d,
        Camera {
            order: 0,
            clear_color: ClearColorConfig::Custom(Color::BLACK),
            ..default()
        },
        CrtCamera,
        LensDistortion::default(),
        ChromaticAberration::default(),
        Vignette::default(),
    ));

    // Sprite that shows the UI render target 1:1 with the viewport. The main
    // camera's clear color is pure black, so anywhere barrel warp pulls the
    // sprite content inward, the exposed pixels are already black — vignette
    // then just deepens that black at the corners, no visible seam between
    // UI, sprite edge, and background.
    commands.spawn((
        Sprite {
            image: ui_target_handle,
            custom_size: Some(Vec2::new(1280.0, 820.0)),
            ..default()
        },
        Transform::from_xyz(0.0, 0.0, 0.0),
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
    mut camera_query: Query<
        (&mut LensDistortion, &mut ChromaticAberration, &mut Vignette),
        With<CrtCamera>,
    >,
) {
    if !settings.is_changed() {
        return;
    }
    for (mut lens, mut chrom, mut vig) in &mut camera_query {
        lens.intensity = settings.barrel_intensity;
        lens.scale = settings.barrel_scale;
        lens.edge_curvature = settings.barrel_edge_curvature;
        chrom.intensity = settings.chromatic_intensity;
        vig.intensity = settings.vignette_intensity;
        vig.radius = settings.vignette_radius;
        vig.smoothness = settings.vignette_smoothness;
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
