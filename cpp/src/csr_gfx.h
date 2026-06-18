// Shared GDI+ helpers for the CSR renderers (the carnage CSR variant and the
// CSR leaderboard): the embedded Blender Pro typeface and the division emblem
// bitmaps. Kept in one translation unit so the PrivateFontCollection and the
// decoded emblem cache are created once.
#pragma once
#include <string>

namespace Gdiplus {
class FontFamily;
class Bitmap;
}  // namespace Gdiplus

// A resolved Blender Pro face: the family plus the GDI+ style to request from it
// (a dedicated bold family is used at FontStyleRegular; a single family falls
// back to synthesised FontStyleBold). Always non-null — falls back to a system
// font if the embedded TTFs can't be loaded.
struct BlenderFace {
    const Gdiplus::FontFamily* family;
    int style;  // Gdiplus::FontStyle
};

// Body/row text uses bold=false; headlines/section titles use bold=true.
BlenderFace blenderFace(bool bold);

// The decoded CSR division emblem for `key` ("diamond-5", "onyx", "champion"),
// or nullptr if the key is unknown. Cached for the process lifetime.
Gdiplus::Bitmap* csrEmblem(const std::string& key);
