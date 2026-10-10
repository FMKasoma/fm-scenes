# fm_scenes

**Version 0.1.0** · HogwartsMP

`fm_scenes` adds persistent, placeable descriptions and character roleplay text to HogwartsMP. Create environmental scenes, leave writing or physical documents in the world, and display short character statuses and actions during roleplay.

## Requirements

- HogwartsMP server with JavaScript resource support
- `hmp-lib`, `hmp-ui`, `hmp-mysql`, and `hmp-core` (the versions declared in `package.json`)
- A working MySQL connection configured for `hmp-mysql`
- `hmp-admin` for administrative scene moderation commands

## Installation

1. Extract the archive into your server's `resources` directory. The resulting folder must be named `fm_scenes`.
2. Run `fm_scenes/sql/fm_scenes.sql` against the database used by the server. The SQL file uses `CREATE TABLE IF NOT EXISTS` and can be run on an existing installation without deleting scenes.
3. Check `fm_scenes/config.json` and adjust the limits and display settings to suit your server.
4. Ensure the required resources are installed and load before `fm_scenes`.
5. Start or restart your HogwartsMP server and verify that `fm_scenes` loads without errors.

To update an existing installation, back up the folder and replace its resource files. Keep your existing database and review `config.json` before overwriting local settings.

## Player commands

| Command | Function |
| --- | --- |
| `/scene` | Create a scene or document at a chosen world position. |
| `/scenes` | List your scenes, edit their contents and position, or delete them. |
| `/me <status>` | Attach a persistent status to your character. Enter `/me` again to clear it. |
| `/do <action>` | Display a timed action above your character and in nearby chat. |

### Placing a scene

1. Use `/scene` and complete the scene form.
2. Aim your camera toward the intended location.
3. **Hold Q** to move the placement point closer or **hold E** to move it farther away.
4. **Click the middle mouse button** to place it, or press **Escape** to cancel.

Placement distance is adjustable between 0.5 and 10 meters by default. The available viewing radius for a completed scene is configured separately in the form.

### Scene categories

| Category | Description | Text visibility |
| --- | --- | --- |
| **Scene** | Environmental descriptions without a physical document model. | Automatically visible when in range. |
| **Writing** | Written text, automatically enclosed in quotation marks. No physical model. | Automatically visible when in range. |
| **Letter** | A physical letter in the world. | Hold **Left Alt** to read when in range. |
| **Parchment** | A physical scroll with selectable **Flat Parchment** (Scroll B) or **Curved Parchment** (Scroll E) model. | Hold **Left Alt** to read when in range. |

Every scene has its own visibility distance and duration. Setting the duration to `0` creates a permanent scene, if permitted by the server configuration. Scenes are stored in MySQL and restored after restart.

### Text formatting

The scene editor supports formatting within a single description:

| Enter in the description | Display |
| --- | --- |
| `**important**` | Bold text |
| `__important__` | Underlined text |
| `**bold and __underlined__**` | Combined emphasis |
| `First line\nSecond line` | Two lines within the same description |

Use the literal characters `\n` for a line break. Some HogwartsMP input builds do not insert a newline when Enter is pressed in the text field.

For example:

```text
**Charms — Lesson III**\nRead __Chapter Four__ before the next class.
```

Font and color choices are available in the scene editor. The menu provides representative names and samples; final appearance is determined by the in-game renderer and available browser fonts.

### Editing scenes

Use `/scenes`, choose one of your scenes, then select **Edit and reposition**. The editor preloads the saved text, category, parchment model, visibility, font, color, and remaining duration. You can revise the text and place the scene at a new position. Deleting a scene removes its associated world object.

## Character roleplay text

**`/me`** displays a status around the character's body, visible to players within **5 meters**. The status stays active until the character uses `/me` again to remove it. Only one status is active per character at a time; statuses are not saved across disconnects.

Example:

```text
/me appears exhausted and disheveled
```

**`/do`** displays an action above the character for **10 seconds** and sends the same action to nearby chat. The displayed action is wrapped in asterisks and begins with the active character's first name.

Example:

```text
/do doodles on their notes
```

Displayed text:

```text
*Mikhail doodles on their notes*
```

The default `/do` range is **10 meters**. `/me` and `/do` can appear at the same time when the multi-label renderer is running.

## Administration

The following commands require the capability configured by `creation.adminDeleteCapability` (default: `admin.view`) through `hmp-admin`:

| Command | Function |
| --- | --- |
| `/scenesadmin` | Browse and delete scenes from other players across the server. |
| `/scenedelete <id>` | Delete a scene by database ID. |
| `/scenewb <x> <y> <z>` | Create a scene at specific F6 World Builder coordinates (Unreal units). |

Admin deletion is enabled by `creation.allowAdminDeleteAll`. The admin browser has a configurable result limit.

## Configuration

All settings are in `config.json`. Common options include:

- **`visibility`** — category-specific display rules, maximum viewing distance, and the Left Alt inspect key.
- **`creation`** — per-player scene limits, maximum duration, text length, placement distance, and admin permissions.
- **`render`** — placement controls, movement speed, and preview update intervals.
- **`previewMarker`** — physical Letter/Parchment models and preview behavior.
- **`roleplay`** — `/me` and `/do` ranges, offsets, duration, cooldowns, and position synchronization.
- **`multiLabelRenderer`** — enable/disable the web overlay, its refresh interval, label limit, and fallback camera field of view.

Configuration changes take effect after restarting the resource or server.

## Display notes

The multi-label renderer draws nearby descriptions in a transparent web overlay. It supports multiple descriptions at once, including environmental scenes and player-attached text. If the overlay cannot initialize, the resource can fall back to HogwartsMP's native prompt display, which shows only one description at a time.

Text is projected using camera coordinates rather than rendered as 3D geometry. Labels may remain visible through walls or objects, and alignment may vary with camera field of view. Some optional decorative fonts are approximated using standard browser font families. The current renderer is intended for testing on a live HogwartsMP client before widespread deployment.

## Database

The single maintained schema file is `sql/fm_scenes.sql`. The `fm_scenes` table stores world scenes and their formatting, positions, owners, and expiration times. Character `/me` and `/do` text is temporary and is not written to the database.

## Support and troubleshooting

- **No scenes appear:** Confirm that `hmp-mysql` is connected, the SQL file has been applied, and the client joined the correct game area and virtual world.
- **Only one description appears:** Check client logs for multi-label overlay initialization; the native fallback supports one prompt.
- **Letter or parchment model is missing:** Confirm that the selected Unreal asset exists and is available to the game client.
- **Text is offset from a moving player:** Check the rendering refresh and roleplay synchronization options, and tune the camera field-of-view fallback if necessary.
- **Enter does not make a line break:** Type `\n` in the description field.

