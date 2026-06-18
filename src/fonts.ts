/**
 * Registers the Blender Pro typeface — the family Halo: MCC uses for its UI /
 * carnage report ($BodyFont "Blender Halo", $TitleFont "Blender Halo Thick" in
 * MCC's Data/UI/config/fontdefinition.xml) — so the rendered PNGs read like the
 * in-game screens. Importing this module registers the fonts as a side effect;
 * the renderers then reference them by the aliases below.
 *
 * Registered under explicit aliases (not the bold keyword) so weight selection is
 * deterministic regardless of each file's internal name/weight metadata.
 */
import { GlobalFonts } from "@napi-rs/canvas";
import { fileURLToPath } from "node:url";

/** Body / row text (Blender Pro Medium). Quote-wrapped for the canvas font string. */
export const FONT = '"Blender Pro", Arial';
/** Headlines / section titles (Blender Pro Bold). */
export const FONT_BOLD = '"Blender Pro Bold", Arial';

const fontPath = (file: string): string => fileURLToPath(new URL(`../assets/fonts/${file}`, import.meta.url));

GlobalFonts.registerFromPath(fontPath("BlenderPro-Medium.ttf"), "Blender Pro");
GlobalFonts.registerFromPath(fontPath("BlenderPro-Bold.ttf"), "Blender Pro Bold");
